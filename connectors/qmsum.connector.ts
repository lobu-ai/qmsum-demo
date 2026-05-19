/**
 * QMSum meeting-transcript connector.
 *
 * Self-fetches the Yale-LILY QMSum corpus from GitHub via
 * `fileSystemSourceFromUri` (@lobu/connector-sdk@8) and emits one event per
 * *merged speaking turn* — raw per-turn events are useless because the
 * corpus is full of "Yeah .", "Hmm hmm ." single-word turns that drown the
 * embedding index. Consecutive turns by the same speaker collapse into one
 * event; turn_idx_start and turn_idx_end keep the original indices so gold
 * `relevant_text_span` overlap math still works.
 *
 * No manual `git clone` step is required — the SDK manages a shallow clone
 * under `${WORKSPACE_DIR}/.lobu-cache/sources/`.
 *
 * Speaker identity rules (encoded as namespace prefixes so cross-domain
 * collisions can never happen):
 *   - Academic: per-meeting   → "academic::<meeting_id>::<label>"
 *   - Product:  per-domain    → "product::<label>"
 *   - Committee: per-domain   → "committee::<label>"
 *
 * Topics from the source file's `topic_list` annotate each event whose
 * (turn_idx_start, turn_idx_end) overlaps a topic's `relevant_text_span`.
 *
 * Auto-discovered by `lobu apply` because the filename ends in
 * `.connector.ts`. Definition key is `qmsum`.
 */

import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  fileSystemSourceFromUri,
  type Snapshot,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// QMSum is a static research corpus, so we pin the URI at module scope. The
// SDK does a shallow clone the first time `fetch()` runs and reuses the cache
// on subsequent syncs.
const QMSUM_URI = "git+https://github.com/Yale-LILY/QMSum@main";

// ─── Types we read out of QMSum source JSON ────────────────────────────────

interface QmsumTurn {
  speaker: string;
  content: string;
}

interface QmsumTopicEntry {
  topic: string;
  // QMSum stores spans as [[startTurnIdxStr, endTurnIdxStr]] (zero-based turn
  // indices encoded as strings) — sometimes multiple spans, sometimes one.
  relevant_text_span: string[][];
}

interface QmsumFile {
  topic_list?: QmsumTopicEntry[];
  general_query_list?: Array<{ query: string; answer: string }>;
  specific_query_list?: Array<{
    query: string;
    answer: string;
    relevant_text_span?: string[][];
  }>;
  meeting_transcripts: QmsumTurn[];
}

// ─── Connector config / checkpoint ─────────────────────────────────────────

interface QmsumConfig {
  per_domain_limit?: number;
}

interface QmsumCheckpoint {
  // Commit SHA captured at the time of the last successful sync. When the
  // upstream repo's ref is unchanged AND the per-domain cap hasn't been
  // raised, we short-circuit with zero events.
  ref?: string;
  // Each entry is the relative source-file path inside the cloned repo —
  // guards against reruns picking up already-ingested meetings when the
  // operator bumps per_domain_limit later.
  seen_meetings: string[];
  // Cap at the time of the prior sync. If the operator raises it, we ignore
  // the ref short-circuit because the same commit now exposes more files.
  per_domain_limit: number;
}

const DOMAINS = ["Academic", "Product", "Committee"] as const;
type Domain = (typeof DOMAINS)[number];

const SPLIT_PREFERENCE = ["test", "val", "train"] as const;

const MAX_PAYLOAD_CHARS = 8_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function speakerScopeForDomain(domain: Domain): "per-meeting" | "per-domain" {
  return domain === "Academic" ? "per-meeting" : "per-domain";
}

function speakerIdentityFor(
  domain: Domain,
  meetingId: string,
  label: string
): string {
  const cleanLabel = label.trim();
  if (domain === "Academic") {
    return `academic::${meetingId}::${cleanLabel}`;
  }
  if (domain === "Product") {
    return `product::${cleanLabel}`;
  }
  return `committee::${cleanLabel}`;
}

function parseSpanPair(pair: string[] | undefined): [number, number] | null {
  if (!pair || pair.length < 2) return null;
  const start = Number.parseInt(pair[0] ?? "", 10);
  const end = Number.parseInt(pair[1] ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [Math.min(start, end), Math.max(start, end)];
}

function rangesOverlap(
  a: [number, number],
  b: [number, number]
): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

interface MergedTurn {
  speaker: string;
  startIdx: number;
  endIdx: number;
  text: string;
}

function mergeConsecutive(turns: QmsumTurn[]): MergedTurn[] {
  const merged: MergedTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn) continue;
    const speaker = (turn.speaker ?? "").trim();
    const content = (turn.content ?? "").trim();
    if (!speaker && !content) continue;
    const last = merged[merged.length - 1];
    if (last && last.speaker === speaker) {
      last.endIdx = i;
      last.text = `${last.text} ${content}`.trim();
    } else {
      merged.push({ speaker, startIdx: i, endIdx: i, text: content });
    }
  }
  return merged;
}

function topicSlugFor(
  topics: QmsumTopicEntry[],
  range: [number, number]
): string | undefined {
  for (const entry of topics) {
    const spans = Array.isArray(entry?.relevant_text_span)
      ? entry.relevant_text_span
      : [];
    for (const pair of spans) {
      const parsed = parseSpanPair(pair);
      if (!parsed) continue;
      if (rangesOverlap(parsed, range)) {
        return slugify(entry.topic ?? "");
      }
    }
  }
  return undefined;
}

function meetingIdFromRelativePath(relativePath: string): string {
  // Canonical QMSum filename without extension (e.g. "Bed003", "ES2004a",
  // "covid_4"). The agent's SOUL.md citation contract — `[meeting_id turns
  // X–Y]` — expects exactly this form, and prepare-fixtures.ts emits the
  // same string, so retrieval round-trips.
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.endsWith(".json") ? base.slice(0, -".json".length) : base;
}

async function collectMatchingFiles(
  snapshot: Snapshot,
  glob: string
): Promise<string[]> {
  const out: string[] = [];
  for await (const path of snapshot.walkFiles(glob)) {
    out.push(path);
  }
  // Sort for deterministic per_domain_limit slicing.
  return out.sort();
}

async function pickSplitFiles(
  snapshot: Snapshot,
  domain: Domain
): Promise<string[]> {
  for (const split of SPLIT_PREFERENCE) {
    const files = await collectMatchingFiles(
      snapshot,
      `data/${domain}/${split}/*.json`
    );
    if (files.length > 0) return files;
  }
  // Some QMSum mirrors flatten the splits — fall back to the domain dir.
  const flat = await collectMatchingFiles(snapshot, `data/${domain}/*.json`);
  return flat;
}

function safeParseJson(raw: string): QmsumFile | null {
  try {
    return JSON.parse(raw) as QmsumFile;
  } catch {
    return null;
  }
}

// ─── Connector class ───────────────────────────────────────────────────────

export default class QmsumConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "qmsum",
    name: "QMSum meeting transcripts",
    description:
      "Ingests Yale-LILY QMSum meeting transcripts (Academic, Product, Committee) as merged speaking-turn events. Self-fetches the corpus from GitHub on first sync — no manual clone required.",
    version: "2.0.0",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      transcripts: {
        key: "transcripts",
        name: "Meeting transcripts",
        description:
          "One event per merged speaking turn across Academic / Product / Committee meetings.",
        configSchema: {
          type: "object",
          properties: {
            per_domain_limit: {
              type: "integer",
              minimum: 1,
              description:
                "Cap on meetings per domain to ingest (useful for demos). Default 10.",
            },
          },
        },
        eventKinds: {
          speaker_turn: {
            description:
              "A merged run of consecutive turns by the same speaker inside one meeting.",
            metadataSchema: {
              type: "object",
              required: [
                "meeting_id",
                "domain",
                "speaker_label",
                "speaker_identity",
                "speaker_scope",
                "turn_idx_start",
                "turn_idx_end",
              ],
              properties: {
                meeting_id: { type: "string" },
                domain: {
                  type: "string",
                  enum: ["Academic", "Product", "Committee"],
                },
                source_file: { type: "string" },
                speaker_label: { type: "string" },
                speaker_identity: { type: "string" },
                speaker_scope: {
                  type: "string",
                  enum: ["per-meeting", "per-domain"],
                },
                turn_idx_start: { type: "integer" },
                turn_idx_end: { type: "integer" },
                topic_slug: { type: "string" },
              },
            },
            entityLinks: [
              {
                entityType: "meeting",
                autoCreate: true,
                titlePath: "metadata.meeting_title",
                identities: [
                  {
                    namespace: "qmsum_meeting",
                    eventPath: "metadata.meeting_id",
                  },
                ],
                traits: {
                  meeting_id: {
                    eventPath: "metadata.meeting_id",
                    behavior: "init_only",
                  },
                  domain: {
                    eventPath: "metadata.domain",
                    behavior: "init_only",
                  },
                  source_file: {
                    eventPath: "metadata.source_file",
                    behavior: "init_only",
                  },
                  title: {
                    eventPath: "metadata.meeting_title",
                    behavior: "prefer_non_empty",
                  },
                },
              },
              {
                entityType: "speaker",
                autoCreate: true,
                titlePath: "metadata.speaker_label",
                identities: [
                  {
                    namespace: "qmsum_speaker",
                    eventPath: "metadata.speaker_identity",
                  },
                ],
                traits: {
                  label: {
                    eventPath: "metadata.speaker_label",
                    behavior: "init_only",
                  },
                  domain: {
                    eventPath: "metadata.domain",
                    behavior: "init_only",
                  },
                  scope: {
                    eventPath: "metadata.speaker_scope",
                    behavior: "init_only",
                  },
                  meeting_id: {
                    eventPath: "metadata.meeting_id",
                    behavior: "init_only",
                  },
                },
              },
            ],
          },
        },
      },
    },
    // Connection-level options are empty — `per_domain_limit` lives on the
    // `transcripts` feed's `configSchema`. The server's
    // `splitConfigByFeedScope` rejects connection-level config whose keys
    // overlap any feed's `configSchema` with the error "Feed-scoped config
    // belongs on feeds."
    optionsSchema: {
      type: "object",
      properties: {},
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as QmsumConfig;
    const perDomainLimit = Math.max(1, config?.per_domain_limit ?? 10);

    const prev = ctx.checkpoint as QmsumCheckpoint | null;

    const source = fileSystemSourceFromUri(QMSUM_URI);
    const snapshot = await source.fetch();

    // Short-circuit when nothing changed AND the operator didn't widen the
    // per-domain cap. A bumped cap requires a re-walk because the previous
    // run may have stopped before the now-eligible files.
    if (
      prev?.ref === snapshot.ref &&
      typeof prev.per_domain_limit === "number" &&
      prev.per_domain_limit >= perDomainLimit
    ) {
      return {
        events: [],
        checkpoint: { ...prev } as unknown as Record<string, unknown>,
        metadata: {
          items_found: 0,
          meetings_ingested: 0,
          ref: snapshot.ref,
          skipped: true,
          reason: "unchanged-ref",
        },
      };
    }

    const seen = new Set<string>(prev?.seen_meetings ?? []);
    const events: EventEnvelope[] = [];
    const newlySeen: string[] = [];

    for (const domain of DOMAINS) {
      const files = (await pickSplitFiles(snapshot, domain)).slice(
        0,
        perDomainLimit
      );

      for (const sourceFileRel of files) {
        // Checkpoint key uses the relative source path (not meeting_id) so
        // two QMSum files that share a canonical stem across splits/domains
        // are independently tracked.
        if (seen.has(sourceFileRel)) continue;

        let raw: string;
        try {
          raw = await snapshot.readText(sourceFileRel);
        } catch {
          continue;
        }
        const data = safeParseJson(raw);
        if (!data || !Array.isArray(data.meeting_transcripts)) continue;

        const meetingId = meetingIdFromRelativePath(sourceFileRel);
        const topics = Array.isArray(data.topic_list) ? data.topic_list : [];
        const merged = mergeConsecutive(data.meeting_transcripts);
        if (merged.length === 0) continue;

        const meetingTitle = `${domain} — ${meetingId}`;
        const scope = speakerScopeForDomain(domain);

        for (const turn of merged) {
          const range: [number, number] = [turn.startIdx, turn.endIdx];
          const topicSlug = topicSlugFor(topics, range);
          const identity = speakerIdentityFor(
            domain,
            meetingId,
            turn.speaker
          );
          const text =
            turn.text.length > MAX_PAYLOAD_CHARS
              ? `${turn.text.slice(0, MAX_PAYLOAD_CHARS - 3)}...`
              : turn.text;

          events.push({
            // Prefix with the source file's relative path so two meetings
            // with the same canonical stem under different domains/splits
            // (or any future flattened mirror) still get unique origin_ids.
            // metadata.meeting_id stays the canonical stem for citations.
            origin_id: `${sourceFileRel}#${turn.startIdx}-${turn.endIdx}`,
            origin_type: "speaker_turn",
            semantic_type: "communication",
            title: `${turn.speaker} — ${meetingTitle} (turns ${turn.startIdx}–${turn.endIdx})`,
            payload_text: text,
            author_name: turn.speaker,
            occurred_at: new Date(),
            metadata: {
              meeting_id: meetingId,
              meeting_title: meetingTitle,
              domain,
              source_file: sourceFileRel,
              speaker_label: turn.speaker,
              speaker_identity: identity,
              speaker_scope: scope,
              turn_idx_start: turn.startIdx,
              turn_idx_end: turn.endIdx,
              ...(topicSlug ? { topic_slug: topicSlug } : {}),
            },
          });
        }

        seen.add(sourceFileRel);
        newlySeen.push(sourceFileRel);
      }
    }

    const nextCheckpoint: QmsumCheckpoint = {
      ref: snapshot.ref,
      seen_meetings: [...(prev?.seen_meetings ?? []), ...newlySeen],
      per_domain_limit: perDomainLimit,
    };

    return {
      events,
      checkpoint: nextCheckpoint as unknown as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        meetings_ingested: newlySeen.length,
        ref: snapshot.ref,
      },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }
}

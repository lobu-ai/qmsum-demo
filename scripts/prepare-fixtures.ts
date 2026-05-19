/**
 * Samples QMSum and emits four JSONL fixture files under .eval-fixtures/:
 *
 *   - specific.jsonl       — specific_query_list with gold answers + gold spans
 *                            (also carries the retrieval-recall asserts)
 *   - general.jsonl        — general_query_list with gold summaries
 *   - attribution.jsonl    — specific queries where a speaker label is named
 *   - cross-meeting.jsonl  — hand-authored, ~5 rows that synthesize across two meetings
 *
 * Each row is a promptfoo TestCase: { vars, assert, description }. promptfoo
 * picks up the JSONL files via the top-level `tests:` array in the
 * promptfooconfig.yaml. We embed asserts in the row (rather than in
 * `scenarios:`) because promptfoo's `scenarios` schema doesn't accept
 * file:// JSONL refs — it expects fully-materialized test arrays.
 *
 * Stratified across the three QMSum domains (Academic / Product / Committee).
 * Reads from data/qmsum/data/{domain}/(test|val|train)/*.json, preferring
 * test split, falling back to val then train. Gold spans (the original
 * relevant_text_span pairs from QMSum) ride along on each specific row so
 * the turn-overlap.js judge can score retrieval against ground truth.
 *
 * Run with: bun run scripts/prepare-fixtures.ts
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

interface QmsumTurn {
  speaker: string;
  content: string;
}

interface QmsumQuery {
  query: string;
  answer: string;
  relevant_text_span?: string[][];
}

interface QmsumFile {
  topic_list?: Array<{ topic: string; relevant_text_span?: string[][] }>;
  general_query_list?: QmsumQuery[];
  specific_query_list?: QmsumQuery[];
  meeting_transcripts: QmsumTurn[];
}

const DOMAINS = ["Academic", "Product", "Committee"] as const;
type Domain = (typeof DOMAINS)[number];

const SPLIT_PREFERENCE = ["test", "val", "train"] as const;

const PER_DOMAIN_SPECIFIC = 15;
const PER_DOMAIN_GENERAL = 10;
const PER_DOMAIN_ATTRIB = 5;

const DATA_DIR = resolve(process.env.QMSUM_DATA_DIR ?? "./data/qmsum/data");
const OUT_DIR = resolve(".eval-fixtures");

interface PromptfooTestRow {
  description?: string;
  vars: Record<string, unknown>;
  assert: Array<Record<string, unknown>>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function meetingIdFromPath(domain: Domain, split: string | null, filePath: string): string {
  const file = basename(filePath, ".json");
  return slugify(`${domain}-${split ?? "root"}-${file}`);
}

function listJsonFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function pickSplit(domainDir: string): { dir: string; label: string | null } | null {
  for (const split of SPLIT_PREFERENCE) {
    const candidate = join(domainDir, split);
    if (listJsonFiles(candidate).length > 0) {
      return { dir: candidate, label: split };
    }
  }
  if (listJsonFiles(domainDir).length > 0) {
    return { dir: domainDir, label: null };
  }
  return null;
}

function parseSpans(spans: string[][] | undefined): number[][] {
  if (!Array.isArray(spans)) return [];
  const out: number[][] = [];
  for (const pair of spans) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const s = Number.parseInt(pair[0] ?? "", 10);
    const e = Number.parseInt(pair[1] ?? "", 10);
    if (Number.isFinite(s) && Number.isFinite(e)) {
      out.push([Math.min(s, e), Math.max(s, e)]);
    }
  }
  return out;
}

function findSpeakerInQuery(query: string, transcripts: QmsumTurn[]): string | null {
  const labels = new Set<string>();
  for (const turn of transcripts) {
    const label = (turn?.speaker ?? "").trim();
    if (label) labels.add(label);
  }
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  const lower = query.toLowerCase();
  for (const label of sorted) {
    if (label.length < 3) continue;
    if (lower.includes(label.toLowerCase())) return label;
  }
  return null;
}

function takeStratified<T>(rows: T[], perDomainCap: number): T[] {
  return rows.slice(0, perDomainCap);
}

function writeJsonl(file: string, rows: PromptfooTestRow[]): void {
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(file, lines + (rows.length > 0 ? "\n" : ""), "utf8");
}

// ─── Per-scenario assert factories ─────────────────────────────────────

function specificAsserts(): Array<Record<string, unknown>> {
  return [
    {
      type: "llm-rubric",
      value:
        "The answer addresses {{query}} and aligns factually with the gold answer below. " +
        "Phrasing may vary. The response cites at least one `[meeting_id turns X–Y]` " +
        "reference and does NOT speculate beyond the transcript.\n\nGold answer:\n{{gold_answer}}",
    },
  ];
}

function generalAsserts(): Array<Record<string, unknown>> {
  return [
    {
      type: "llm-rubric",
      value:
        "A faithful ~150-word summary of meeting {{meeting_id}} covering decisions, " +
        "open questions, and topics raised. Cites at least two `[meeting_id turns X–Y]` " +
        "ranges. Aligned with the gold summary:\n\n{{gold_answer}}",
    },
    { type: "answer-relevance", threshold: 0.6 },
  ];
}

function attributionAsserts(): Array<Record<string, unknown>> {
  return [
    { type: "icontains", value: "{{expected_speaker}}" },
    { type: "icontains", value: "{{meeting_id}}" },
  ];
}

function crossMeetingAsserts(): Array<Record<string, unknown>> {
  return [
    {
      type: "llm-rubric",
      value:
        "A synthesis answer to {{query}} that draws on at least two different " +
        "meetings. Cites at least two distinct meeting_ids in `[meeting_id turns X–Y]` " +
        "form. Grounded only in the QMSum transcripts. Expected coverage:\n\n{{gold_answer}}",
    },
  ];
}

function retrievalAsserts(): Array<Record<string, unknown>> {
  return [
    { type: "javascript", value: "file://judges/turn-overlap.js" },
    {
      type: "context-recall",
      contextTransform: "metadata.retrievedContext",
      threshold: 0.5,
      value: "{{gold_answer}}",
    },
    {
      type: "context-faithfulness",
      contextTransform: "metadata.retrievedContext",
      threshold: 0.6,
    },
  ];
}

// ─── Main ──────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(DATA_DIR)) {
    console.error(
      `prepare-fixtures: QMSum data dir not found at ${DATA_DIR}. ` +
        `Clone with: git clone https://github.com/Yale-LILY/QMSum.git data/qmsum`
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const specific: PromptfooTestRow[] = [];
  const general: PromptfooTestRow[] = [];
  const attribution: PromptfooTestRow[] = [];
  const retrieval: PromptfooTestRow[] = [];

  for (const domain of DOMAINS) {
    const domainDir = join(DATA_DIR, domain);
    const split = pickSplit(domainDir);
    if (!split) {
      console.warn(`prepare-fixtures: no data found under ${domainDir}`);
      continue;
    }

    const files = listJsonFiles(split.dir);
    const domainSpecific: PromptfooTestRow[] = [];
    const domainGeneral: PromptfooTestRow[] = [];
    const domainAttrib: PromptfooTestRow[] = [];
    const domainRetrieval: PromptfooTestRow[] = [];

    for (const filePath of files) {
      let parsed: QmsumFile;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8")) as QmsumFile;
      } catch {
        continue;
      }
      if (!Array.isArray(parsed.meeting_transcripts)) continue;

      const meetingId = meetingIdFromPath(domain, split.label, filePath);

      for (const row of parsed.specific_query_list ?? []) {
        if (!row?.query || !row?.answer) continue;
        const goldSpans = parseSpans(row.relevant_text_span);
        const vars = {
          query: row.query,
          gold_answer: row.answer,
          meeting_id: meetingId,
          domain,
          gold_spans: goldSpans,
        };
        domainSpecific.push({
          description: `answer-quality — ${meetingId}`,
          vars,
          assert: specificAsserts(),
        });
        domainRetrieval.push({
          description: `retrieval-recall — ${meetingId}`,
          vars,
          assert: retrievalAsserts(),
        });

        const speaker = findSpeakerInQuery(row.query, parsed.meeting_transcripts);
        if (speaker) {
          domainAttrib.push({
            description: `speaker-attribution — ${meetingId}`,
            vars: {
              query: row.query,
              gold_answer: row.answer,
              expected_speaker: speaker,
              meeting_id: meetingId,
              domain,
            },
            assert: attributionAsserts(),
          });
        }
      }

      for (const row of parsed.general_query_list ?? []) {
        if (!row?.query || !row?.answer) continue;
        domainGeneral.push({
          description: `meeting-summary — ${meetingId}`,
          vars: {
            query: row.query,
            gold_answer: row.answer,
            meeting_id: meetingId,
            domain,
          },
          assert: generalAsserts(),
        });
      }
    }

    specific.push(...takeStratified(domainSpecific, PER_DOMAIN_SPECIFIC));
    general.push(...takeStratified(domainGeneral, PER_DOMAIN_GENERAL));
    attribution.push(...takeStratified(domainAttrib, PER_DOMAIN_ATTRIB));
    retrieval.push(...takeStratified(domainRetrieval, PER_DOMAIN_SPECIFIC));
  }

  writeJsonl(join(OUT_DIR, "specific.jsonl"), specific);
  writeJsonl(join(OUT_DIR, "general.jsonl"), general);
  writeJsonl(join(OUT_DIR, "attribution.jsonl"), attribution);
  writeJsonl(join(OUT_DIR, "retrieval-recall.jsonl"), retrieval);

  // Cross-meeting fixtures are hand-authored — the QMSum dataset doesn't
  // contain queries that span meetings. These five rows are deliberately
  // domain-flavored so they exercise the agent's per-domain speaker rules.
  const crossMeeting: PromptfooTestRow[] = [
    {
      description: "cross-meeting — AMI Product positioning evolution",
      vars: {
        query:
          "Across the AMI Product design meetings, how did Marketing's positioning argument evolve between the kickoff and the final design meeting?",
        gold_answer:
          "Marketing started by anchoring on a high-end consumer segment and the role of a fashionable look; by the conceptual / detailed design meetings, the argument had shifted to balance branding against the cost ceiling the Project Manager kept reasserting. The agent should retrieve from at least two distinct Product meetings and cite both.",
        domain: "Product",
      },
      assert: crossMeetingAsserts(),
    },
    {
      description: "cross-meeting — AMI Product cost consistency",
      vars: {
        query:
          "Compare how cost was treated in two different AMI Product meetings — was the Project Manager consistent across them?",
        gold_answer:
          "The Project Manager consistently anchored the team to the 12.50-euro / 25-euro retail target, but the framing changed: in earlier meetings cost was a top-line constraint, in later ones it became a trade-off against feature scope (LCD vs LEDs, advanced chip vs simple). Answer should cite two Product meetings.",
        domain: "Product",
      },
      assert: crossMeetingAsserts(),
    },
    {
      description: "cross-meeting — Committee mental health across hearings",
      vars: {
        query:
          "In the Welsh Senedd committee sessions, how did the topic of mental health support for young people surface across more than one hearing?",
        gold_answer:
          "Multiple Committee sessions returned to mental-health access — covering CAMHS waiting lists, school-based counselling, and the role of third-sector providers. The agent must cite at least two Committee meeting ids.",
        domain: "Committee",
      },
      assert: crossMeetingAsserts(),
    },
    {
      description: "cross-meeting — Academic evaluation disagreements",
      vars: {
        query:
          "Across two Academic group meetings, what disagreements came up about evaluation methodology?",
        gold_answer:
          "Academic meetings repeatedly debated evaluation methodology — whether a held-out test set was sufficient, whether the group's metrics matched the downstream task, and whether automatic metrics agreed with human judgements. Per-meeting speaker labels mean the same 'Grad A' across files is NOT the same person; the agent should make that explicit.",
        domain: "Academic",
      },
      assert: crossMeetingAsserts(),
    },
    {
      description: "cross-meeting — AMI Product action-item closure",
      vars: {
        query:
          "Synthesize action items across two AMI Product meetings: what was deferred to the next meeting and what was closed out?",
        gold_answer:
          "Action items typically closed within a meeting include role-allocation and immediate sketch tasks; deferrals usually involve cost-confirmation, supplier-spec checks, and user-study scheduling. Answer must cite at least two Product meetings and distinguish closed vs deferred.",
        domain: "Product",
      },
      assert: crossMeetingAsserts(),
    },
  ];

  writeJsonl(join(OUT_DIR, "cross-meeting.jsonl"), crossMeeting);

  console.log("prepare-fixtures: wrote fixtures to", OUT_DIR);
  console.log("  specific.jsonl         ", specific.length);
  console.log("  general.jsonl          ", general.length);
  console.log("  attribution.jsonl      ", attribution.length);
  console.log("  cross-meeting.jsonl    ", crossMeeting.length);
  console.log("  retrieval-recall.jsonl ", retrieval.length);
}

main();

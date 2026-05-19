/**
 * Samples QMSum and emits four JSONL fixture files under .eval-fixtures/:
 *
 *   - specific.jsonl       — specific_query_list with gold answers + gold spans
 *                            (answer-quality llm-rubric)
 *   - general.jsonl        — general_query_list with gold summaries
 *   - attribution.jsonl    — specific queries where a speaker label is named
 *   - cross-meeting.jsonl  — hand-authored, ~5 rows that synthesize across two meetings
 *   - retrieval-recall.jsonl — same vars as specific.jsonl with retrieval asserts
 *
 * Why retrieval-recall duplicates specific.jsonl's vars: promptfoo's top-level
 * `tests:` accepts file://jsonl entries but every row in the JSONL is parsed
 * as a TestCaseSchema (i.e. its own `assert` block), and `scenarios:` rejects
 * file:// refs entirely. There's no shape in the v0.121 config schema that
 * lets us bind two different `assert` blocks to one file. Re-emit it.
 *
 * Reads from data/qmsum/data/{domain}/(test|val|train)/*.json, preferring
 * test split, falling back to val then train. Gold spans (the original
 * relevant_text_span pairs from QMSum) ride along on each specific row so
 * the turn-overlap.js judge can score retrieval against ground truth.
 *
 * Sampling is deterministic first-N per domain (sorted filenames) for
 * reproducibility. Pass --random with --seed=N to randomize. --limit N
 * overrides the per-domain cap.
 *
 * Run with: bun run scripts/prepare-fixtures.ts [--limit N] [--random] [--seed N]
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

const DEFAULT_LIMIT_PER_DOMAIN = 15;
const PER_DOMAIN_GENERAL = 10;
const PER_DOMAIN_ATTRIB = 5;

const DATA_DIR = resolve(process.env.QMSUM_DATA_DIR ?? "./data/qmsum/data");
const OUT_DIR = resolve(".eval-fixtures");
const CROSS_MEETING_CASES = resolve("agents/qmsum/evals/cross-meeting-cases.json");

interface PromptfooTestRow {
  description?: string;
  vars: Record<string, unknown>;
  assert: Array<Record<string, unknown>>;
}

interface CliFlags {
  limit: number;
  random: boolean;
  seed: number;
}

function parseFlags(argv: string[]): CliFlags {
  let limit = DEFAULT_LIMIT_PER_DOMAIN;
  let random = false;
  let seed = 1;

  // Support both `--limit=N` / `--limit N` and `--seed=N` / `--seed N`.
  const readValue = (i: number, name: string): { n: number; consumed: number } | null => {
    const arg = argv[i] ?? "";
    if (arg.startsWith(`${name}=`)) {
      const n = Number.parseInt(arg.slice(name.length + 1), 10);
      return Number.isFinite(n) ? { n, consumed: 1 } : null;
    }
    if (arg === name) {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      return Number.isFinite(n) ? { n, consumed: 2 } : null;
    }
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--random") {
      random = true;
      continue;
    }
    const lim = readValue(i, "--limit");
    if (lim) {
      if (lim.n > 0) limit = lim.n;
      i += lim.consumed - 1;
      continue;
    }
    const sd = readValue(i, "--seed");
    if (sd) {
      seed = sd.n;
      i += sd.consumed - 1;
      continue;
    }
  }
  return { limit, random, seed };
}

// Mulberry32 — deterministic PRNG seeded by `--seed`.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i]!, arr[j]!] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function meetingIdFromPath(filePath: string): string {
  // Canonical QMSum filename without extension (e.g. "Bed003", "ES2004a",
  // "covid_4"). The agent's SOUL.md citation contract — `[meeting_id turns
  // X–Y]` — expects exactly this form, and the connector emits the same
  // string in event metadata, so they round-trip.
  return basename(filePath, ".json");
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

function writeJsonl(file: string, rows: PromptfooTestRow[]): void {
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(file, lines + (rows.length > 0 ? "\n" : ""), "utf8");
}

function loadCrossMeetingRows(): PromptfooTestRow[] {
  if (!existsSync(CROSS_MEETING_CASES)) {
    console.warn(`prepare-fixtures: cross-meeting cases not found at ${CROSS_MEETING_CASES}`);
    return [];
  }
  const raw = readFileSync(CROSS_MEETING_CASES, "utf8");
  const parsed = JSON.parse(raw) as Array<{
    description: string;
    query: string;
    gold_answer: string;
    domain: Domain;
  }>;
  const assert = [
    {
      type: "llm-rubric",
      value:
        "A synthesis answer to {{query}} that draws on at least two different " +
        "meetings. Cites at least two distinct meeting_ids in `[meeting_id turns X–Y]` " +
        "form. Grounded only in the QMSum transcripts. Expected coverage:\n\n{{gold_answer}}",
    },
  ];
  return parsed.map((c) => ({
    description: c.description,
    vars: { query: c.query, gold_answer: c.gold_answer, domain: c.domain },
    assert,
  }));
}

// ─── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const flags = parseFlags(process.argv.slice(2));

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

  const rand = flags.random ? mulberry32(flags.seed) : null;

  for (const domain of DOMAINS) {
    const domainDir = join(DATA_DIR, domain);
    const split = pickSplit(domainDir);
    if (!split) {
      console.warn(`prepare-fixtures: no data found under ${domainDir}`);
      continue;
    }

    let files = listJsonFiles(split.dir);
    if (rand) files = shuffleInPlace([...files], rand);
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

      const meetingId = meetingIdFromPath(filePath);

      for (const row of parsed.specific_query_list ?? []) {
        if (!row?.query || !row?.answer) continue;
        const goldSpans = parseSpans(row.relevant_text_span);
        const vars = {
          query: row.query,
          gold_answer: row.answer,
          meeting_id: meetingId,
          domain,
          split: split.label,
          gold_spans: goldSpans,
        };
        domainSpecific.push({
          description: `answer-quality — ${meetingId}`,
          vars,
          assert: [
            {
              type: "llm-rubric",
              value:
                "The answer addresses {{query}} and aligns factually with the gold answer below. " +
                "Phrasing may vary. The response cites at least one `[meeting_id turns X–Y]` " +
                "reference and does NOT speculate beyond the transcript.\n\nGold answer:\n{{gold_answer}}",
            },
          ],
        });
        domainRetrieval.push({
          description: `retrieval-recall — ${meetingId}`,
          vars,
          assert: [
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
          ],
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
              split: split.label,
            },
            assert: [
              { type: "icontains", value: "{{expected_speaker}}" },
              { type: "icontains", value: "{{meeting_id}}" },
            ],
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
            split: split.label,
          },
          assert: [
            {
              type: "llm-rubric",
              value:
                "A faithful ~150-word summary of meeting {{meeting_id}} covering decisions, " +
                "open questions, and topics raised. Cites at least two `[meeting_id turns X–Y]` " +
                "ranges. Aligned with the gold summary:\n\n{{gold_answer}}",
            },
            { type: "answer-relevance", threshold: 0.6 },
          ],
        });
      }
    }

    // --limit caps every per-domain list (specific/general/attribution/
    // retrieval) so the documented "limit" stays honest. General and
    // attribution still have their own natural caps below the default.
    specific.push(...domainSpecific.slice(0, flags.limit));
    general.push(...domainGeneral.slice(0, Math.min(flags.limit, PER_DOMAIN_GENERAL)));
    attribution.push(...domainAttrib.slice(0, Math.min(flags.limit, PER_DOMAIN_ATTRIB)));
    retrieval.push(...domainRetrieval.slice(0, flags.limit));
  }

  writeJsonl(join(OUT_DIR, "specific.jsonl"), specific);
  writeJsonl(join(OUT_DIR, "general.jsonl"), general);
  writeJsonl(join(OUT_DIR, "attribution.jsonl"), attribution);
  writeJsonl(join(OUT_DIR, "retrieval-recall.jsonl"), retrieval);

  const crossMeeting = loadCrossMeetingRows();
  writeJsonl(join(OUT_DIR, "cross-meeting.jsonl"), crossMeeting);

  const mode = flags.random ? `random (seed=${flags.seed})` : "deterministic first-N";
  console.log(`prepare-fixtures: wrote fixtures to ${OUT_DIR} (${mode}, limit=${flags.limit})`);
  console.log("  specific.jsonl         ", specific.length);
  console.log("  general.jsonl          ", general.length);
  console.log("  attribution.jsonl      ", attribution.length);
  console.log("  cross-meeting.jsonl    ", crossMeeting.length);
  console.log("  retrieval-recall.jsonl ", retrieval.length);
}

main();

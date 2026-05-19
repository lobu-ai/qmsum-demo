# qmsum-demo

A standalone, end-to-end demo of [**Lobu**](https://lobu.ai) +
[**QMSum**](https://github.com/Yale-LILY/QMSum) (Yale-LILY's meeting
summarization benchmark).

It does three things:

1. **Ingests the QMSum corpus** into Lobu memory via a custom connector
   (`connectors/qmsum.connector.ts`) — one event per *merged speaking turn*,
   with per-domain speaker scoping that respects QMSum's label semantics
   (Academic per-meeting; Product/Committee per-domain).
2. **Defines a `qmsum` agent** grounded in those events — every claim is
   cited as `[meeting_id turns X–Y]`.
3. **Benchmarks the agent with ROUGE-L** against QMSum's gold answers — the
   same metric the QMSum paper reports for BART / HMNet baselines, so the
   numbers are directly comparable to published results.

> **Heads up — auth bootstrap is still in flight.** A fresh `lobu run` on a
> clean machine boots with an empty user table, and there is no headless
> CLI command that creates the install-operator account yet. Track Lobu
> PR [`feat/install-operator-bootstrap`](https://github.com/lobu-ai/lobu/pulls?q=is%3Apr+install-operator-bootstrap)
> for the fix. Workarounds while you wait are in the
> [Auth bootstrap](#auth-bootstrap-current-blocker) section below.

---

## What this demonstrates

Most retrieval evals run against frozen datasets and an opaque retrieval
stack. This repo flips that around — the *agent's own memory* is the eval
surface. You ingest QMSum into Lobu the same way you would ingest Slack
history or a Notion workspace, then score the agent's grounded answers
against QMSum's gold annotations.

---

## Prereqs

- **Node.js 22.x – 24.x** (`.nvmrc` and `.node-version` pin 22).
  Node 25+ is rejected by Lobu — `isolated-vm` has no Node 25+ build yet.
- **Bun** — `curl -fsSL https://bun.sh/install | bash`.
- **Postgres with `pgvector`** — `DATABASE_URL=postgres://…`.
- **`@lobu/cli`** — `npm i -g @lobu/cli`.
- **[uv](https://docs.astral.sh/uv/)** — for the Python benchmark runner.
- **QMSum dataset** — **not required for ingestion.** The connector
  self-fetches the corpus from GitHub via
  [`fileSystemSourceFromUri`](https://www.npmjs.com/package/@lobu/connector-sdk)
  on first sync (shallow clone into `${WORKSPACE_DIR}/.lobu-cache/`,
  ~5s over network). The benchmark, however, needs a local clone of
  QMSum for the gold answers — `make clone-data` (writes to
  `./data/qmsum`, separate from the connector's cache).

---

## Setup

```bash
# 1. Clone + bootstrap env
cp .env.example .env                       # ANTHROPIC_API_KEY, DATABASE_URL, ENCRYPTION_KEY (openssl rand -hex 32)
bun install

# 2. Clone the QMSum dataset for the benchmark gold answers
#    (gitignored — never committed; only needed for `make benchmark`,
#    the connector self-fetches its own ingestion cache)
make clone-data

# 3. Boot Lobu locally (separate terminal — keep it running)
lobu run                                   # gateway on http://localhost:8787

# 3. Push the org / entities / connector definition + register the feed.
#    `lobu apply` writes the `qmsum-transcripts` connection + `transcripts`
#    feed and schedules the first sync — the gateway worker picks it up
#    automatically. The connector self-fetches the QMSum corpus into
#    `${WORKSPACE_DIR}/.lobu-cache/` on first run (~5s shallow clone over
#    network). No manual `git clone` required.
#
#    The feed schedule is `0 0 1 1 0` (Jan 1, effectively once-yearly)
#    because `cron-parser` has no `@once` macro; for ad-hoc re-ingestion
#    use the admin dashboard's `trigger_feed` action on the `transcripts`
#    feed.
#
#    Smoke-test the connector locally without persisting events:
#      lobu connector run qmsum --check
lobu apply

# 4. Run the benchmark (after ingestion finishes — see `Benchmark` below)
export LOBU_API_TOKEN=$(lobu token)
make benchmark
```

---

## Benchmark

The benchmark scores agent responses against QMSum's gold `specific_query_list`
answers with **ROUGE-1, ROUGE-2, and ROUGE-Lsum** (precision, recall, f-measure),
aggregated per-domain and overall. ROUGE-Lsum is the summary-level LCS variant
the QMSum paper reports for BART / HMNet baselines:

- **BART / HMNet** (Zhong et al. 2021): ROUGE-L ≈ 0.20–0.25
- **GPT-3 / Llama-2** (follow-up papers): ROUGE-L ≈ 0.30–0.40

> **Caveats:**
> 1. Paper baselines were given gold context. We score full RAG-grounded
>    agent output — the agent has to retrieve the relevant turns from Lobu
>    memory itself. Strictly harder task; treat comparison as apples-to-
>    oranges-ish but useful for ballpark sanity-checking.
> 2. We benchmark only `specific_query_list[]` (per-meeting Q&A), not
>    `general_query_list[]` (full-meeting summaries). Specific queries are
>    the more common headline in QMSum follow-up work and what the agent's
>    citation contract (`[meeting_id turns X–Y]`) is tuned for.
> 3. Each query is prefaced with `(Meeting context: <meeting_id> — <domain>
>    domain. Retrieve from this meeting only.)` so retrieval is scoped to
>    the right transcript. Without this, ambiguous queries like
>    "Summarize the discussion" would retrieve corpus-wide and tank ROUGE
>    for reasons unrelated to the agent's quality.

### Running it

```bash
# Sanity check (no gateway needed — scores gold-vs-gold, expects R-L = 1.0)
make benchmark-dry

# Real run (needs `lobu run` up + ingestion finished + LOBU_API_TOKEN set)
export LOBU_API_TOKEN=$(lobu token)
make benchmark
```

The runner walks `data/qmsum/data/<domain>/(test|val|train)/*.json` (preferring
the test split, falling back to val then train — same as the connector),
samples up to `--limit-per-domain` meetings per domain (default 15,
deterministic alphabetical-by-filename for reproducibility), and runs every
`specific_query_list[]` entry through the agent.

Each query goes through the Lobu Agent API: `POST /lobu/api/v1/agents` to
create a session, `POST /messages` to send the question, `GET /events` for
the SSE stream, `DELETE` to clean up.

Useful flags:

```bash
uv run scripts/run-benchmark.py \
  --gateway http://localhost:8787 \
  --agent qmsum \
  --limit-per-domain 5 \
  --random --seed 42 \
  --output benchmark-results-$(date +%s).json
```

The full per-query results land in `benchmark-results.json` (gitignored)
alongside the printed summary table, so you can inspect any specific
query's response, error, latency, and per-metric scores.

### Cost

Live runs print an estimated cost based on `queries × ~$0.05/query` (Anthropic
Sonnet, rough order-of-magnitude). Default `--limit-per-domain 15` produces
~200 queries against QMSum's test split (Academic 6 meetings × ~6q/m, Product
20 meetings × ~6q/m capped at 15, Committee 6 meetings × ~12q/m), so budget
~$10 for a full run; pass `-y` to skip the confirmation prompt.

---

## Demo script (3 beats)

These are the moments that show the whole point of the stack — copy them
into a screen recording or a live talk.

### Beat 1 — grounded specific Q&A

```bash
lobu chat -a qmsum "What did the Project Manager decide about the remote in the AMI final design meeting?"
```

The agent retrieves merged turns from one Product meeting, answers in 2–4
sentences, and cites them as `[<meeting_id> turns X–Y]`. No retrieval,
no answer.

### Beat 2 — same memory, two clients

Open Claude Desktop and Cursor side by side, both pointing at the same
Lobu MCP server (the `qmsum-demo` org). Ask Claude Desktop to summarize
an Academic meeting; in Cursor, ask follow-up attribution questions
about who raised what. The agent reads from the **same Lobu memory** —
zero copies of the QMSum corpus, zero separate vector stores.

### Beat 3 — transparent failure

```bash
lobu chat -a qmsum "What did the AMI team decide about post-2010 firmware updates?"
```

The corpus stops in 2008. The agent should retrieve nothing relevant,
then say so plainly ("the transcripts don't cover that") — not invent
an answer.

---

## Auth bootstrap (current blocker)

As of **2026-05-19**, `lobu run` on a freshly created `LOBU_DATA_DIR`
has no install-operator user, so `lobu login` against `http://localhost:8787`
can't complete and you can't mint a `LOBU_API_TOKEN` without a manual
workaround. The fix is in flight as Lobu PR
[`feat/install-operator-bootstrap`](https://github.com/lobu-ai/lobu/pulls?q=is%3Apr+install-operator-bootstrap).

**Workarounds until that lands:**

- **Lobu Cloud.** Point `LOBU_GATEWAY` at `https://app.lobu.ai` (or your
  cloud workspace URL), sign up via the web UI, then `lobu login`
  against the same host. The cloud install handles bootstrap for you.
- **Reuse an already-bootstrapped install.** If you've already booted
  Lobu locally before (the monorepo's `bun run dev` or a prior
  `lobu run`), point this project at that gateway and use the existing
  user — same workflow, no bootstrap step.
- **Use the existing landlord-mode UI.** Hit
  `http://localhost:8787/api/auth/sign-up` once (any HTTP client) with
  an email + password — per Lobu PR #902 the *first* sign-up becomes the
  install's identity. Then `lobu login` to mint a token. (This is the
  workaround that the in-flight PR turns into a one-liner.)

---

## Known limitations

- **Per-turn embeddings vs longer-context need.** Merged speaking turns
  mitigate the "Yeah ." / "Hmm hmm ." embedding-noise problem but they
  don't fully solve coverage for long, slowly-developing arguments
  (especially in Committee hearings).
- **Single-pass benchmark.** The runner creates a fresh agent session per
  query, so it measures cold-start retrieval, not long-horizon recall
  inside a thread. Conversational multi-turn benchmarking is a follow-up.
- **ROUGE is lexical.** ROUGE-L correlates with paper baselines but doesn't
  reward paraphrase-grounded answers fairly. BERTScore is a sensible
  follow-up; we intentionally ship ROUGE-only for the paper-comparable
  headline.

---

## License

This repo is BUSL-1.1, matching Lobu. The
[**QMSum dataset**](https://github.com/Yale-LILY/QMSum) is the property
of Yale-LILY and ships under its own license terms — see that repo for
details. None of the dataset is checked in here.

---

## Credits

- [Yale-LILY](https://github.com/Yale-LILY) for the
  [QMSum](https://github.com/Yale-LILY/QMSum) benchmark.
- [google-research/google-research](https://github.com/google-research/google-research/tree/master/rouge)
  for `rouge-score`.
- [Lobu](https://lobu.ai) for the agent runtime and memory model.

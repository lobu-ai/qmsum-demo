# qmsum-demo

A standalone, end-to-end demo of [**Lobu**](https://lobu.ai) +
[**promptfoo**](https://www.promptfoo.dev) +
[**QMSum**](https://github.com/Yale-LILY/QMSum) (Yale-LILY's meeting
summarization benchmark).

It does three things at once:

1. **Ingests the QMSum corpus** into Lobu memory via a custom connector
   (`connectors/qmsum.connector.ts`) — one event per *merged speaking turn*,
   with per-domain speaker scoping that respects QMSum's label semantics
   (Academic per-meeting; Product/Committee per-domain).
2. **Defines a `qmsum` agent** grounded in those events — every claim is
   cited as `[meeting_id turns X–Y]`.
3. **Evaluates the agent with promptfoo**, using
   [`@lobu/promptfoo-provider`](https://www.npmjs.com/package/@lobu/promptfoo-provider).
   Five scenarios cover specific Q&A, meeting summarization, speaker
   attribution, cross-meeting synthesis, and retrieval-recall (turn-overlap
   judge + `context-recall` / `context-faithfulness` powered by the
   gateway's `tool_use` SSE event surfaced as `metadata.toolCalls` /
   `metadata.retrievedContext`).

> **Heads up — auth bootstrap is still in flight.** A fresh `lobu run` on a
> clean machine boots with an empty user table, and there is no headless
> CLI command that creates the install-operator account yet. Track Lobu
> PR [`feat/install-operator-bootstrap`](https://github.com/lobu-ai/lobu/pulls?q=is%3Apr+install-operator-bootstrap)
> for the fix. Workarounds while you wait are in the
> [Auth bootstrap](#auth-bootstrap-current-blocker) section below.

---

## What this demonstrates

Most retrieval evals are run against frozen datasets and an opaque
retrieval stack. This repo flips that around — the *agent's own memory*
is the eval surface. You ingest QMSum into Lobu the same way you would
ingest Slack history or a Notion workspace, point a promptfoo config at
it, and get standard RAG metrics out the other side (`context-recall`,
`context-faithfulness`, plus a custom turn-overlap judge that scores
retrieval against the gold `relevant_text_span` annotations).

---

## Prereqs

- **Node.js 22.x – 24.x** (`.nvmrc` and `.node-version` pin 22).
  Node 25+ is rejected by Lobu — `isolated-vm` has no Node 25+ build yet.
- **Bun** — `curl -fsSL https://bun.sh/install | bash`.
- **Postgres with `pgvector`** — `DATABASE_URL=postgres://…`.
- **`@lobu/cli`** — `npm i -g @lobu/cli`.
- **QMSum dataset** — `git clone https://github.com/Yale-LILY/QMSum.git data/qmsum`.

---

## Setup

```bash
# 1. Clone + bootstrap env
cp .env.example .env                       # fill ANTHROPIC_API_KEY, DATABASE_URL, ENCRYPTION_KEY (openssl rand -hex 32)
bun install

# 2. Clone the QMSum dataset (gitignored — never committed)
make clone-data                            # equivalent: git clone https://github.com/Yale-LILY/QMSum.git data/qmsum

# 3. Boot Lobu locally (separate terminal — keep it running)
lobu run                                   # gateway on http://localhost:8787

# 4. Push the org / entities / connector definition + register the feed.
#    `lobu apply` writes the `qmsum-transcripts` connection + `transcripts`
#    feed and schedules the first sync — the gateway worker picks it up
#    automatically. The feed schedule is `0 0 1 1 0` (Jan 1, effectively
#    once-yearly) because `cron-parser` has no `@once` macro; for ad-hoc
#    re-ingestion use the admin dashboard's `trigger_feed` action on the
#    `transcripts` feed.
#
#    Smoke-test the connector locally without persisting events:
#      lobu connector run qmsum --check
lobu apply

# 5. Sample fixtures + run promptfoo evals
export LOBU_TOKEN=$(lobu token)
bun run prepare-fixtures                   # writes .eval-fixtures/{specific,general,attribution,cross-meeting}.jsonl
bun run evals                              # runs the 5 scenarios in agents/qmsum/evals/promptfooconfig.yaml
bun run evals:view                         # comparison grid in the browser
```

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
an answer. Promptfoo's `context-faithfulness` assertion in the
`retrieval-recall` scenario is what catches the *opposite* failure
mode (an answer that drifts off the retrieved context).

---

## Auth bootstrap (current blocker)

As of **2026-05-19**, `lobu run` on a freshly created `LOBU_DATA_DIR`
has no install-operator user, so `lobu login` against `http://localhost:8787`
can't complete and you can't mint a `LOBU_TOKEN` without a manual
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
  (especially in Committee hearings). The retrieval-recall scenario's
  threshold (`>= 0.5` context-recall) is calibrated for that.
- **Hand-authored cross-meeting fixtures.** QMSum's native queries are
  scoped to one meeting at a time. `cross-meeting.jsonl` is five
  hand-written prompts — exercise them as smoke tests, not as a
  population-level metric.
- **Single eval run per agent thread.** The provider creates one Lobu
  thread per promptfoo row; we don't (yet) share threads across rows
  to test long-horizon recall. The `vars.transcript` multi-turn
  support is there if you want to add it (see
  [`@lobu/promptfoo-provider` README](https://github.com/lobu-ai/lobu/tree/main/packages/promptfoo-provider)).

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
- [Lobu](https://lobu.ai) for the agent runtime, memory model, and
  promptfoo provider.

#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "rouge-score>=0.1.2",
#   "requests>=2.31",
# ]
# ///
"""
QMSum ROUGE-L benchmark runner for the Lobu qmsum agent.

For each domain (Academic, Product, Committee) we walk
<QMSUM_DATA_DIR>/<domain>/(test|val|train)/*.json (preferring test split, falling
back to val then train — same as connectors/qmsum.connector.ts), take up to
--limit-per-domain meetings, and for every entry in `specific_query_list[]`:

  1. POST   {GATEWAY}/lobu/api/v1/agents              → create session
  2. POST   {GATEWAY}/lobu/api/v1/agents/<id>/messages → send the query
  3. GET    {GATEWAY}/lobu/api/v1/agents/<id>/events   → SSE stream until `complete`
  4. DELETE {GATEWAY}/lobu/api/v1/agents/<id>          → cleanup

Each agent response is scored against the gold `answer` with ROUGE-1/2/L
(precision, recall, f-measure) via google/rouge-score. We then aggregate
per-domain and overall means, dump a JSON results file, and pretty-print a
summary table.

Two modes:

  - --dry-run  → skip every gateway call; score the gold answer against itself
                 to verify the runner compiles + parses QMSum cleanly. Used in
                 CI / when the Lobu install hasn't finished ingestion yet.
  - default    → live gateway calls; you must `lobu apply` + wait for sync first.

Sampling is deterministic alphabetical-by-filename by default (so the same
--limit-per-domain run always picks the same meetings). Pass --random --seed N
to randomize while staying reproducible.

Env / flags:
  --gateway          LOBU_GATEWAY (default http://localhost:8787)
  --token            LOBU_API_TOKEN
  --agent            LOBU_AGENT  (default qmsum)
  --data-dir         QMSUM_DATA_DIR (default ./data/qmsum/data)
  --limit-per-domain LIMIT_PER_DOMAIN (default 15) — meetings, not queries
  --output           OUTPUT (default benchmark-results.json)
  --random / --seed  randomize meeting selection; seed defaults to 1
  --timeout          per-query SSE timeout, seconds (default 180)
  --dry-run          skip gateway, score gold-vs-gold
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from rouge_score import rouge_scorer

DOMAINS = ("Academic", "Product", "Committee")
SPLIT_PREFERENCE = ("test", "val", "train")
ROUGE_METRICS = ("rouge1", "rouge2", "rougeL")
# Rough Anthropic Sonnet pricing as of 2026-05 — order-of-magnitude only,
# good enough for a "this will cost ~$X" headline before you press enter.
ESTIMATED_COST_PER_QUERY_USD = 0.05


# ─── QMSum loading ───────────────────────────────────────────────────────────


@dataclass
class QueryCase:
    domain: str
    meeting_id: str
    source_file: str  # relative to data-dir, for traceability in results
    query: str
    gold_answer: str


def pick_split_dir(domain_dir: Path) -> Path | None:
    for split in SPLIT_PREFERENCE:
        candidate = domain_dir / split
        if candidate.is_dir() and any(candidate.glob("*.json")):
            return candidate
    # Some QMSum mirrors flatten the splits — fall back to the domain dir.
    if domain_dir.is_dir() and any(domain_dir.glob("*.json")):
        return domain_dir
    return None


def list_meeting_files(split_dir: Path) -> list[Path]:
    return sorted(p for p in split_dir.iterdir() if p.is_file() and p.suffix == ".json")


def load_cases(
    data_dir: Path,
    limit_per_domain: int,
    randomize: bool,
    seed: int,
) -> list[QueryCase]:
    cases: list[QueryCase] = []
    rng = random.Random(seed) if randomize else None
    for domain in DOMAINS:
        domain_dir = data_dir / domain
        split_dir = pick_split_dir(domain_dir)
        if split_dir is None:
            print(f"  warning: no data under {domain_dir}", file=sys.stderr)
            continue
        files = list_meeting_files(split_dir)
        if rng is not None:
            files = list(files)
            rng.shuffle(files)
        files = files[:limit_per_domain]
        for path in files:
            try:
                data = json.loads(path.read_text())
            except json.JSONDecodeError as exc:
                print(f"  warning: failed to parse {path}: {exc}", file=sys.stderr)
                continue
            meeting_id = path.stem
            source_file = str(path.relative_to(data_dir))
            for entry in data.get("specific_query_list", []) or []:
                query = (entry or {}).get("query", "")
                gold = (entry or {}).get("answer", "")
                if not isinstance(query, str) or not isinstance(gold, str):
                    continue
                query = query.strip()
                gold = gold.strip()
                if not query or not gold:
                    continue
                cases.append(
                    QueryCase(
                        domain=domain,
                        meeting_id=meeting_id,
                        source_file=source_file,
                        query=query,
                        gold_answer=gold,
                    )
                )
    return cases


# ─── Lobu Agent API client (mirrors packages/promptfoo-provider/src/provider.ts) ─


class LobuAgentClient:
    def __init__(self, gateway: str, token: str, agent: str, timeout_s: float):
        self.gateway = gateway.rstrip("/")
        self.token = token
        self.agent = agent
        self.timeout_s = timeout_s

    def _headers(self, session_token: str | None = None) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {session_token or self.token}",
        }

    def create_session(self, thread: str) -> dict[str, str]:
        res = requests.post(
            f"{self.gateway}/lobu/api/v1/agents",
            headers=self._headers(),
            json={
                "agentId": self.agent,
                "thread": thread,
                "forceNew": True,
                "dryRun": True,
            },
            timeout=30,
        )
        res.raise_for_status()
        data = res.json()
        return {
            "agentId": data["agentId"],
            "token": data["token"],
            "base": f"{self.gateway}/lobu/api/v1/agents/{data['agentId']}",
        }

    def send_message(self, session: dict[str, str], content: str) -> str | None:
        res = requests.post(
            f"{session['base']}/messages",
            headers=self._headers(session["token"]),
            json={"content": content},
            timeout=30,
        )
        res.raise_for_status()
        body = res.json()
        return body.get("messageId")

    def collect_response(
        self, session: dict[str, str], message_id: str | None
    ) -> tuple[str, str | None]:
        """Stream SSE events until 'complete' or 'error'. Returns (text, error)."""
        text: list[str] = []
        err: str | None = None
        with requests.get(
            f"{session['base']}/events",
            headers={"Authorization": f"Bearer {session['token']}"},
            stream=True,
            timeout=self.timeout_s,
        ) as res:
            res.raise_for_status()
            current_event = ""
            for raw_line in res.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                line = raw_line
                if line.startswith("event: "):
                    current_event = line[7:].strip()
                    continue
                if line.startswith("data: ") and current_event:
                    payload_str = line[6:]
                    try:
                        payload = json.loads(payload_str)
                    except json.JSONDecodeError:
                        current_event = ""
                        continue
                    if not isinstance(payload, dict):
                        current_event = ""
                        continue
                    if message_id and payload.get("messageId") not in (
                        message_id,
                        None,
                    ):
                        current_event = ""
                        continue
                    if current_event == "output":
                        chunk = payload.get("content")
                        if isinstance(chunk, str):
                            text.append(chunk)
                    elif current_event == "complete":
                        return "".join(text), None
                    elif current_event == "error":
                        err = str(payload.get("error") or "Unknown agent error")
                        return "".join(text), err
                    current_event = ""
                elif line == "":
                    current_event = ""
        return "".join(text), err or "stream-ended-without-complete"

    def delete_session(self, session: dict[str, str]) -> None:
        try:
            requests.delete(
                session["base"],
                headers={"Authorization": f"Bearer {session['token']}"},
                timeout=10,
            )
        except requests.RequestException:
            pass

    def ask(self, query: str, thread: str) -> tuple[str, str | None]:
        session = self.create_session(thread)
        try:
            message_id = self.send_message(session, query)
            return self.collect_response(session, message_id)
        finally:
            self.delete_session(session)


# ─── Scoring ────────────────────────────────────────────────────────────────


def make_scorer() -> rouge_scorer.RougeScorer:
    # use_stemmer=True matches the QMSum paper's reported numbers (they used
    # the canonical rouge-1.5.5 perl impl, which stems). google/rouge-score's
    # stemmer is an English-only Porter stemmer — close enough for the paper-
    # comparable headline.
    return rouge_scorer.RougeScorer(list(ROUGE_METRICS), use_stemmer=True)


@dataclass
class ScoredResult:
    domain: str
    meeting_id: str
    source_file: str
    query: str
    gold_answer: str
    response: str
    error: str | None = None
    scores: dict[str, dict[str, float]] = field(default_factory=dict)
    latency_ms: int = 0


def score_pair(scorer: rouge_scorer.RougeScorer, gold: str, response: str) -> dict[str, dict[str, float]]:
    raw = scorer.score(gold, response)
    out: dict[str, dict[str, float]] = {}
    for metric, score in raw.items():
        out[metric] = {
            "precision": score.precision,
            "recall": score.recall,
            "fmeasure": score.fmeasure,
        }
    return out


def aggregate(results: list[ScoredResult]) -> dict[str, Any]:
    """Returns {'per_domain': {domain: {...}}, 'overall': {...}, 'counts': {...}}."""

    def mean(values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    def empty_aggregate() -> dict[str, dict[str, float]]:
        return {m: {"precision": 0.0, "recall": 0.0, "fmeasure": 0.0} for m in ROUGE_METRICS}

    def aggregate_subset(subset: list[ScoredResult]) -> dict[str, dict[str, float]]:
        if not subset:
            return empty_aggregate()
        agg: dict[str, dict[str, float]] = {}
        for metric in ROUGE_METRICS:
            agg[metric] = {
                "precision": mean([r.scores.get(metric, {}).get("precision", 0.0) for r in subset if not r.error]),
                "recall": mean([r.scores.get(metric, {}).get("recall", 0.0) for r in subset if not r.error]),
                "fmeasure": mean([r.scores.get(metric, {}).get("fmeasure", 0.0) for r in subset if not r.error]),
            }
        return agg

    per_domain: dict[str, dict[str, Any]] = {}
    counts: dict[str, dict[str, int]] = {"per_domain": {}, "overall": {}}
    for domain in DOMAINS:
        subset = [r for r in results if r.domain == domain]
        per_domain[domain] = aggregate_subset(subset)
        counts["per_domain"][domain] = sum(1 for r in subset if not r.error)

    overall = aggregate_subset(results)
    counts["overall"] = {
        "scored": sum(1 for r in results if not r.error),
        "errored": sum(1 for r in results if r.error),
        "total": len(results),
    }
    return {"per_domain": per_domain, "overall": overall, "counts": counts}


# ─── Output ─────────────────────────────────────────────────────────────────


def print_summary(aggregates: dict[str, Any], elapsed_s: float) -> None:
    counts = aggregates["counts"]
    print()
    print("=" * 72)
    print("QMSum ROUGE benchmark — summary")
    print("=" * 72)
    print(
        f"  scored: {counts['overall']['scored']} / {counts['overall']['total']}"
        f"   (errored: {counts['overall']['errored']})  in {elapsed_s:.1f}s"
    )
    print()
    header = f"  {'Domain':<14} {'N':>5} {'R-1 F':>8} {'R-2 F':>8} {'R-L F':>8} {'R-L P':>8} {'R-L R':>8}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for domain in DOMAINS:
        agg = aggregates["per_domain"][domain]
        n = counts["per_domain"][domain]
        print(
            f"  {domain:<14} {n:>5} "
            f"{agg['rouge1']['fmeasure']:>8.4f} "
            f"{agg['rouge2']['fmeasure']:>8.4f} "
            f"{agg['rougeL']['fmeasure']:>8.4f} "
            f"{agg['rougeL']['precision']:>8.4f} "
            f"{agg['rougeL']['recall']:>8.4f}"
        )
    overall = aggregates["overall"]
    n = counts["overall"]["scored"]
    print("  " + "-" * (len(header) - 2))
    print(
        f"  {'OVERALL':<14} {n:>5} "
        f"{overall['rouge1']['fmeasure']:>8.4f} "
        f"{overall['rouge2']['fmeasure']:>8.4f} "
        f"{overall['rougeL']['fmeasure']:>8.4f} "
        f"{overall['rougeL']['precision']:>8.4f} "
        f"{overall['rougeL']['recall']:>8.4f}"
    )
    print()
    print("Baseline reference (QMSum paper, Zhong et al. 2021):")
    print("  - HMNet / BART extractive-abstractive: ROUGE-L ≈ 0.20–0.25")
    print("  - GPT-3 / Llama-2 follow-ups:         ROUGE-L ≈ 0.30–0.40")
    print("  Caveat: we score full-RAG agent output; paper baselines were")
    print("  given gold context. Apples-to-oranges-ish but the canonical metric.")
    print()


# ─── Main ───────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="QMSum ROUGE benchmark runner")
    p.add_argument(
        "--gateway",
        default=os.environ.get("LOBU_GATEWAY", "http://localhost:8787"),
        help="Lobu gateway base URL (default: $LOBU_GATEWAY or http://localhost:8787)",
    )
    p.add_argument(
        "--token",
        default=os.environ.get("LOBU_API_TOKEN", ""),
        help="Bearer token for the Lobu Agent API (default: $LOBU_API_TOKEN)",
    )
    p.add_argument(
        "--agent",
        default=os.environ.get("LOBU_AGENT", "qmsum"),
        help="Agent id (default: $LOBU_AGENT or qmsum)",
    )
    p.add_argument(
        "--data-dir",
        default=os.environ.get("QMSUM_DATA_DIR", "./data/qmsum/data"),
        help="QMSum data dir containing Academic/Product/Committee (default: $QMSUM_DATA_DIR or ./data/qmsum/data)",
    )
    p.add_argument(
        "--limit-per-domain",
        type=int,
        default=int(os.environ.get("LIMIT_PER_DOMAIN", "15")),
        help="Max meetings per domain (default: 15)",
    )
    p.add_argument(
        "--output",
        default=os.environ.get("OUTPUT", "benchmark-results.json"),
        help="Write per-query + aggregate results JSON here (default: benchmark-results.json)",
    )
    p.add_argument("--random", action="store_true", help="Randomize meeting selection")
    p.add_argument("--seed", type=int, default=1, help="Random seed when --random is set (default: 1)")
    p.add_argument("--timeout", type=float, default=180.0, help="Per-query SSE timeout in seconds (default: 180)")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip the gateway, score gold-vs-gold (validates parsing + scoring only)",
    )
    p.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip the cost-confirmation prompt",
    )
    return p.parse_args()


def confirm_cost(num_queries: int, dry_run: bool, yes: bool) -> bool:
    if dry_run:
        return True
    est = num_queries * ESTIMATED_COST_PER_QUERY_USD
    print(
        f"About to run {num_queries} queries against the live gateway. "
        f"Estimated cost: ~${est:.2f} (assumes ~${ESTIMATED_COST_PER_QUERY_USD:.2f}/query Anthropic Sonnet)."
    )
    if yes:
        return True
    answer = input("Continue? [y/N] ").strip().lower()
    return answer in ("y", "yes")


def main() -> int:
    args = parse_args()
    data_dir = Path(args.data_dir).resolve()
    if not data_dir.is_dir():
        print(
            f"error: QMSum data dir not found at {data_dir}. "
            f"Clone with: git clone https://github.com/Yale-LILY/QMSum.git data/qmsum",
            file=sys.stderr,
        )
        return 1

    cases = load_cases(data_dir, args.limit_per_domain, args.random, args.seed)
    if not cases:
        print("error: no QMSum queries found — check --data-dir layout", file=sys.stderr)
        return 1

    counts_by_domain = {d: sum(1 for c in cases if c.domain == d) for d in DOMAINS}
    print(
        f"Loaded {len(cases)} queries "
        f"(Academic={counts_by_domain['Academic']}, "
        f"Product={counts_by_domain['Product']}, "
        f"Committee={counts_by_domain['Committee']}) "
        f"from {data_dir}"
    )
    mode = f"random seed={args.seed}" if args.random else "deterministic alphabetical"
    print(f"Sampling: {mode}; meetings/domain ≤ {args.limit_per_domain}; mode: {'dry-run' if args.dry_run else 'live gateway'}")

    if not args.dry_run:
        if not args.token:
            print("error: --token / $LOBU_API_TOKEN required for live runs (use --dry-run otherwise)", file=sys.stderr)
            return 1
        parsed = urlparse(args.gateway)
        if not parsed.scheme or not parsed.netloc:
            print(f"error: invalid --gateway URL: {args.gateway}", file=sys.stderr)
            return 1

    if not confirm_cost(len(cases), args.dry_run, args.yes):
        print("aborted.")
        return 130

    client = (
        None
        if args.dry_run
        else LobuAgentClient(args.gateway, args.token, args.agent, args.timeout)
    )
    scorer = make_scorer()
    results: list[ScoredResult] = []

    started = time.time()
    for i, case in enumerate(cases, start=1):
        query_start = time.time()
        if args.dry_run:
            response = case.gold_answer
            error: str | None = None
        else:
            try:
                response, error = client.ask(case.query, thread=f"qmsum-bench-{i}")  # type: ignore[union-attr]
            except requests.RequestException as exc:
                response = ""
                error = f"http error: {exc}"
            except Exception as exc:  # noqa: BLE001 — last-resort guard so one bad query doesn't kill the run
                response = ""
                error = f"unexpected error: {exc}"
        latency_ms = int((time.time() - query_start) * 1000)
        scores = score_pair(scorer, case.gold_answer, response) if response and not error else {}
        results.append(
            ScoredResult(
                domain=case.domain,
                meeting_id=case.meeting_id,
                source_file=case.source_file,
                query=case.query,
                gold_answer=case.gold_answer,
                response=response,
                error=error,
                scores=scores,
                latency_ms=latency_ms,
            )
        )
        rl = scores.get("rougeL", {}).get("fmeasure")
        status = "ERROR" if error else f"R-L F={rl:.3f}" if rl is not None else "scored"
        print(
            f"  [{i:>3}/{len(cases)}] {case.domain:<10} {case.meeting_id:<14} "
            f"({latency_ms:>5}ms) {status}"
        )

    elapsed = time.time() - started
    aggregates = aggregate(results)

    output_path = Path(args.output).resolve()
    payload = {
        "config": {
            "gateway": args.gateway,
            "agent": args.agent,
            "data_dir": str(data_dir),
            "limit_per_domain": args.limit_per_domain,
            "random": args.random,
            "seed": args.seed,
            "dry_run": args.dry_run,
            "rouge_stemmer": True,
        },
        "aggregates": aggregates,
        "results": [asdict(r) for r in results],
        "elapsed_seconds": elapsed,
    }
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"\nWrote per-query results to {output_path}")

    print_summary(aggregates, elapsed)
    return 0


if __name__ == "__main__":
    sys.exit(main())

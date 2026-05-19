# Convenience targets for the QMSum demo. Underlying commands are bun / lobu /
# uv invocations — `make` here is just a memo.

.PHONY: help install clone-data apply sync benchmark benchmark-dry typecheck

help:
	@echo "Targets:"
	@echo "  install        — bun install"
	@echo "  clone-data     — git clone Yale-LILY/QMSum into ./data/qmsum (benchmark gold answers — the connector self-fetches its own ingestion cache)"
	@echo "  apply          — lobu apply (creates org + entities + connector definition)"
	@echo "  sync           — lobu connector run qmsum-transcripts (ingests transcripts)"
	@echo "  benchmark      — uv run scripts/run-benchmark.py (ROUGE-L vs QMSum gold)"
	@echo "  benchmark-dry  — uv run scripts/run-benchmark.py --dry-run (skip gateway)"
	@echo "  typecheck      — bunx tsc --noEmit"

install:
	bun install

clone-data:
	@if [ -d data/qmsum/.git ]; then \
	  echo "data/qmsum already present — skipping clone"; \
	else \
	  git clone https://github.com/Yale-LILY/QMSum.git data/qmsum; \
	fi

apply:
	lobu apply

sync:
	lobu connector run qmsum-transcripts

benchmark:
	uv run scripts/run-benchmark.py

benchmark-dry:
	uv run scripts/run-benchmark.py --dry-run

typecheck:
	bunx tsc --noEmit

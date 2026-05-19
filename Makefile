# Convenience targets for the QMSum demo. Underlying commands are all
# straight bun / lobu / promptfoo invocations — `make` here is just a memo.

.PHONY: help install clone-data apply sync fixtures evals view typecheck validate

help:
	@echo "Targets:"
	@echo "  install     — bun install"
	@echo "  clone-data  — git clone Yale-LILY/QMSum into ./data/qmsum (eval fixtures only — the connector self-fetches)"
	@echo "  apply       — lobu apply (creates org + entities + connector definition)"
	@echo "  sync        — lobu connector run qmsum-transcripts (ingests transcripts)"
	@echo "  fixtures    — bun run scripts/prepare-fixtures.ts (writes .eval-fixtures/*.jsonl)"
	@echo "  evals       — promptfoo eval -c agents/qmsum/evals/promptfooconfig.yaml"
	@echo "  view        — promptfoo view (comparison grid in browser)"
	@echo "  typecheck   — bunx tsc --noEmit"
	@echo "  validate    — promptfoo validate (config-only, no gateway needed)"

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

fixtures:
	bun run scripts/prepare-fixtures.ts

evals:
	bun run evals

view:
	bun run evals:view

typecheck:
	bunx tsc --noEmit

validate:
	bunx promptfoo validate -c agents/qmsum/evals/promptfooconfig.yaml

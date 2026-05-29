/**
 * QMSum agent demo — declarative config.
 *
 * Single-agent project: a `qmsum` research assistant grounded in the Yale-LILY
 * QMSum meeting transcripts (Academic / Product / Committee). The QMSum data is
 * ingested via the custom connector at ./connectors/qmsum.connector.ts (key
 * `qmsum`); agent prompts and evals live under ./agents/qmsum/.
 *
 * Run order (see README.md for the full walkthrough):
 *   1. cp .env.example .env  + fill in keys
 *   2. bun install
 *   3. lobu run                   # local gateway + worker
 *   4. lobu apply                 # creates org, entities, connector definition
 *   5. lobu connector run qmsum-transcripts   # self-fetches QMSum from GitHub
 *   6. (optional, only for the eval pipeline) make clone-data
 *   7. bun run prepare-fixtures && bun run evals
 */

import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineEntityType,
  secret,
} from "@lobu/cli/config";
import type QmsumConnector from "./connectors/qmsum.connector.ts";

const qmsum = defineAgent({
  id: "qmsum",
  name: "qmsum",
  description:
    "Research assistant grounded in QMSum meeting transcripts (Academic, Product, Committee).",
  dir: "./agents/qmsum",
  // Standardized on claude-sonnet-4-6.
  providers: [
    {
      id: "anthropic",
      model: "claude-sonnet-4-6",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
});

const meeting = defineEntityType({
  key: "meeting",
  name: "Meeting",
  description: "A QMSum meeting — one source JSON file from the dataset.",
  required: ["meeting_id", "domain"],
  metadata: { icon: "video", color: "#6366F1" },
  properties: {
    meeting_id: {
      type: "string",
      description:
        'Canonical QMSum filename without extension (e.g. "ES2002a", "Bed003", "covid_4").',
      "x-table-label": "Meeting ID",
      "x-table-column": true,
    },
    domain: {
      type: "string",
      enum: ["Academic", "Product", "Committee"],
      "x-table-label": "Domain",
      "x-table-column": true,
    },
    source_file: {
      type: "string",
      description: "Relative path of the source JSON inside data/qmsum.",
    },
    title: {
      type: "string",
      description: "Human-readable title; falls back to meeting_id when absent.",
      "x-table-label": "Title",
      "x-table-column": true,
    },
    topic_count: {
      type: "integer",
      "x-table-label": "Topics",
    },
    turn_count: {
      type: "integer",
      "x-table-label": "Turns",
    },
  },
});

const speaker = defineEntityType({
  key: "speaker",
  name: "Speaker",
  description: [
    "A speaker in the QMSum corpus. Scope depends on domain:",
    '- Academic: per-meeting (labels like "Grad A/B/C/D" are anonymous codes',
    "  that recur across files but mean different people).",
    '- Product: per-domain (AMI labels — "Industrial Designer",',
    '  "Marketing", "Project Manager", "User Interface" — refer to roles',
    "  that recur across all AMI meetings).",
    '- Committee: per-domain (real persistent names like "Barry Hughes",',
    '  "Lynne Neagle AM").',
  ].join("\n"),
  required: ["label", "domain", "scope"],
  metadata: { icon: "user", color: "#10B981" },
  properties: {
    label: {
      type: "string",
      "x-table-label": "Label",
      "x-table-column": true,
    },
    domain: {
      type: "string",
      enum: ["Academic", "Product", "Committee"],
      "x-table-label": "Domain",
      "x-table-column": true,
    },
    scope: {
      type: "string",
      enum: ["per-meeting", "per-domain"],
      "x-table-label": "Scope",
    },
    meeting_id: {
      type: "string",
      description:
        "Present when scope is per-meeting; absent for per-domain speakers.",
      "x-table-label": "Meeting",
    },
  },
});

export default defineConfig({
  org: "qmsum-demo",
  orgName: "QMSum demo",
  orgDescription:
    "Yale-LILY QMSum meeting transcripts indexed for grounded Q&A and summarization.",
  agents: [qmsum],
  entities: [meeting, speaker],
  connectors: [
    connectorFromFile<typeof QmsumConnector>(
      "./connectors/qmsum.connector.ts"
    ),
  ],
});

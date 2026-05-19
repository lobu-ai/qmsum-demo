/**
 * Custom promptfoo assertion: did the agent's search_memory tool calls
 * actually retrieve events whose [turn_idx_start, turn_idx_end] overlap
 * any gold span from the QMSum fixture row?
 *
 * Input shape:
 *   - output:  { text, metadata: { toolCalls: [{ name, input, result_summary }] } }
 *   - context.vars.gold_spans: number[][]  // [[startTurnIdx, endTurnIdx], ...]
 *
 * Pass if any retrieved event's turn range overlaps any gold span.
 * Fail if there are no search_memory calls, or no overlapping retrievals.
 */

/**
 * @param {{ start: number, end: number }} a
 * @param {{ start: number, end: number }} b
 */
function overlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Extract retrieved event ranges from a tool-call trace. We accept either:
 *   1. `result_summary.snippets[].metadata.turn_idx_start/_end`  (preferred — gateway provides this once it lands per-snippet metadata)
 *   2. `result_summary.snippets[].text` containing "turns X–Y" or "turns X-Y" (fallback we parse out of the snippet text, since IDENTITY/SOUL tell the agent to cite that way)
 *
 * @param {unknown} toolCalls
 * @returns {Array<{ start: number, end: number }>}
 */
function rangesFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const name = String(call.name ?? '');
    if (!name.includes('search_memory')) continue;
    const summary = call.result_summary;
    const snippets = summary && Array.isArray(summary.snippets) ? summary.snippets : [];
    for (const snippet of snippets) {
      const meta = snippet && snippet.metadata;
      const s = meta && Number(meta.turn_idx_start);
      const e = meta && Number(meta.turn_idx_end);
      if (Number.isFinite(s) && Number.isFinite(e)) {
        ranges.push({ start: Math.min(s, e), end: Math.max(s, e) });
        continue;
      }
      const text = snippet && typeof snippet.text === 'string' ? snippet.text : '';
      const match = text.match(/turns?\s+(\d+)\s*[–-]\s*(\d+)/i);
      if (match) {
        const s2 = Number(match[1]);
        const e2 = Number(match[2]);
        if (Number.isFinite(s2) && Number.isFinite(e2)) {
          ranges.push({ start: Math.min(s2, e2), end: Math.max(s2, e2) });
        }
      }
    }
  }
  return ranges;
}

module.exports = (output, context) => {
  const toolCalls =
    output && output.metadata && Array.isArray(output.metadata.toolCalls)
      ? output.metadata.toolCalls
      : [];

  const gold = Array.isArray(context && context.vars && context.vars.gold_spans)
    ? context.vars.gold_spans
    : [];

  const goldRanges = gold
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const s = Number(pair[0]);
      const e = Number(pair[1]);
      if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
      return { start: Math.min(s, e), end: Math.max(s, e) };
    })
    .filter(Boolean);

  if (goldRanges.length === 0) {
    return {
      pass: false,
      score: 0,
      reason: 'turn-overlap judge: no gold_spans provided on the test row',
    };
  }

  const retrieved = rangesFromToolCalls(toolCalls);
  if (retrieved.length === 0) {
    return {
      pass: false,
      score: 0,
      reason: 'turn-overlap judge: no search_memory results found in tool-call trace',
    };
  }

  const hit = retrieved.some((r) => goldRanges.some((g) => overlap(r, g)));
  return {
    pass: hit,
    score: hit ? 1 : 0,
    reason: hit
      ? `turn-overlap judge: retrieved ${retrieved.length} range(s); at least one overlaps a gold span`
      : `turn-overlap judge: retrieved ${retrieved.length} range(s) but none overlap the ${goldRanges.length} gold span(s)`,
  };
};

// Deterministic micro-benchmark: projected-context size across a 12-turn
// read-heavy session, hygiene OFF vs ON (recent window 60s, all outputs old).
// Estimates are char/4 (labeled estimated) — not provider tokens.
import { EvidenceStore } from "../src/evidence/store.ts";
import { planHygiene } from "../src/hygiene/hygiene.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT_CHARS = 20000; // per-turn grep-sized tool result
const TURNS = 12;
const NOW = Date.now();

function projected(planEntries, turnIndex) {
  // chars in projected context at turn i: user overhead + surviving outputs
  const markerChars = 160;
  let chars = 4000; // system + user fixed overhead
  for (let t = 0; t < turnIndex; t++) {
    const archived = planEntries.some((e) => e.targetId === `e${t}`);
    chars += archived ? markerChars : OUTPUT_CHARS;
  }
  return chars;
}

const entries = [];
for (let i = 0; i < TURNS; i++) entries.push({ entryId: `e${i}`, chars: OUTPUT_CHARS });

// Hygiene ON: archive everything older than the window (all but the newest).
const dir = mkdtempSync(join(tmpdir(), "pinx-bench-"));
const store = new EvidenceStore(dir);
const candidates = entries.slice(0, TURNS - 1).map((e) => ({
  item: { entryId: e.entryId, role: "toolResult", toolName: "grep", chars: OUTPUT_CHARS, ts: NOW - 120_000, isError: false },
  content: "x".repeat(OUTPUT_CHARS),
}));
const policy = { ...{ archivableTools: new Set(["grep"]), mutatingTools: new Set() }, recentWindowMs: 60_000 };
const plan = await planHygiene("bench", candidates, store, policy, { minChars: 4000, maxEditsPerTurn: 20 }, NOW);

const baselineTurns = [], treatedTurns = [];
for (let t = 1; t <= TURNS; t++) {
  baselineTurns.push(Math.round(projected([], t) / 4));
  treatedTurns.push(Math.round(projected(plan.entries, t) / 4));
}
const base = baselineTurns[baselineTurns.length - 1];
const treat = treatedTurns[treatedTurns.length - 1];
// HONEST METRICS: these are PROJECTED-CONTEXT sizes estimated at chars/4.
// They are NOT provider billing tokens and must never be reported as such.
console.log(JSON.stringify({
  benchmark: "projected-context microbenchmark (synthetic)",
  assumptions: [
    "token figures = visible chars / 4 (estimated, not provider-reported)",
    "hygiene archives every turn older than the 60s window",
    "no model calls; deterministic fixture",
  ],
  turn_count: TURNS,
  tool_output_chars: OUTPUT_CHARS,
  baseline_projected_chars: base * 4,
  treated_projected_chars: treat * 4,
  estimated_tokens_char4: { baseline: base, treated: treat },
  reduction_percent: Number((100 * (1 - treat / base)).toFixed(1)),
  baseline_trajectory_est_tokens: baselineTurns,
  treated_trajectory_est_tokens: treatedTurns,
}, null, 2));
rmSync(dir, { recursive: true, force: true });

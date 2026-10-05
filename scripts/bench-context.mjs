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
const candidates = entries.slice(0, TURNS - 1).map((e, i) => ({
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
console.log(`turns=${TURNS} output=${OUTPUT_CHARS} chars/turn (est tokens)`);
console.log(`baseline final ctx: ${base} tok | treated final ctx: ${treat} tok | reduction: ${(100 * (1 - treat / base)).toFixed(1)}%`);
console.log("baseline traj:", baselineTurns.join(","));
console.log("treated  traj:", treatedTurns.join(","));
rmSync(dir, { recursive: true, force: true });

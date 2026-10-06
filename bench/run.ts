// Agent efficiency benchmark — deterministic scenarios over the REAL Pi
// SessionManager and the REAL hygiene/evidence pipeline. No live model, no
// wall-clock inputs, no randomness (evidence ids are injected).
//
// Run:  npx tsx bench/run.ts   → single JSON object on stdout
//
// Terminology (meta repo docs/benchmark/README.md):
//   "stable prefix" is a local byte metric between serialized projections.
//   It is NOT a provider cache-hit rate and must never be reported as one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { compareProjectionSeries } from "../src/core/cacheability.ts";
import { estimateTextTokens } from "../src/core/estimate.ts";
import { DEFAULT_HYGIENE_POLICY, type HygienePolicy } from "../src/core/types.ts";
import { planHygiene } from "../src/hygiene/hygiene.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { parseMarker } from "../src/core/evidence.ts";
import { createRecallTool } from "../src/recall/tool.ts";
import {
  SESSION_ID,
  SYSTEM_PROMPT,
  resetClock,
  syntheticFile,
  syntheticGrepOutput,
  tick,
  turnMessages,
  type FixtureTurn,
} from "./fixtures.ts";

/** Sequential ref ids that satisfy the store's ev_[0-9a-f]{32} contract. */
function deterministicIdFactory(): () => string {
  let n = 0;
  return () => `ev_${(n++).toString(16).padStart(32, "0")}`;
}

function newSession(): SessionManager {
  return SessionManager.inMemory();
}

function projectionBytes(sm: SessionManager): { bytes: number; json: string; messages: number } {
  const json = JSON.stringify(sm.buildSessionProjection().messages) ?? "";
  return { bytes: Buffer.byteLength(json, "utf8"), json, messages: 0 };
}

const POLICY: HygienePolicy = {
  ...DEFAULT_HYGIENE_POLICY,
  // Benchmark policy = production defaults; nothing tuned to look good.
};

interface ScenarioResult {
  scenario: string;
  description: string;
  turns: number;
  projections: Array<{ bytes: number; estimatedTokens: number }>;
  consecutive: {
    comparisons: Array<{
      commonPrefixBytes: number;
      commonPrefixRatio: number;
      firstChangedByte: number;
    }>;
    averageStablePrefixRatio: number;
    finalCommonPrefixBytes: number;
  };
  counters?: Record<string, number>;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scenario A — repeated coding turns (mostly stable state, small changes)
// ---------------------------------------------------------------------------
async function scenarioA(): Promise<ScenarioResult> {
  resetClock();
  const sm = newSession();
  sm.appendMessage({
    role: "system",
    content: SYSTEM_PROMPT,
    timestamp: tick(),
  } as never);

  const turns: FixtureTurn[] = [];
  for (let t = 0; t < 6; t++) {
    turns.push({
      user: `Implement bench feature ${t}: extend the deterministic module with function ${t}.`,
      toolName: "read",
      toolArgs: { path: `src/module-${t}.ts` },
      toolOutput: syntheticFile(28, `a${t}`), // ~2.5 KB, below the archive threshold
      closing: `Feature ${t} implemented; module ${t} read and verified against the plan.`,
    });
  }

  const serialized: string[] = [];
  let toolCalls = 0;
  let toolResultOriginalBytes = 0;
  for (let t = 0; t < turns.length; t++) {
    for (const message of turnMessages(turns[t]!, `call_a${t}`)) {
      sm.appendMessage(message as never);
    }
    toolCalls++;
    toolResultOriginalBytes += Buffer.byteLength(turns[t]!.toolOutput, "utf8");
    serialized.push(projectionBytes(sm).json);
  }

  const projections = serialized.map((json) => ({
    bytes: Buffer.byteLength(json, "utf8"),
    estimatedTokens: estimateTextTokens(json).value,
  }));
  const series = compareProjectionSeries(serialized);
  return {
    scenario: "A",
    description:
      "six consecutive coding turns; small per-turn outputs below the archive threshold",
    turns: turns.length,
    projections,
    consecutive: {
      comparisons: series.comparisons.map((c) => ({
        commonPrefixBytes: c.commonPrefixBytes,
        commonPrefixRatio: c.commonPrefixRatio,
        firstChangedByte: c.firstChangedByte,
      })),
      averageStablePrefixRatio: series.averageStablePrefixRatio,
      finalCommonPrefixBytes: series.finalCommonPrefixBytes,
    },
    counters: {
      modelVisibleToolCalls: turns.length,
      toolResultOriginalBytes,
      archives: 0,
      recalls: 0,
      compactions: 0,
      contextGenerations: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario B — large read-only output (archive → marker → recall)
// ---------------------------------------------------------------------------
async function scenarioB(): Promise<ScenarioResult> {
  resetClock();
  const dir = mkdtempSync(join(tmpdir(), "pinx-bench-ev-"));
  try {
    const store = new EvidenceStore(join(dir, "evidence"), {
      idFactory: deterministicIdFactory(),
    });
    const sm = newSession();
    sm.appendMessage({ role: "system", content: SYSTEM_PROMPT, timestamp: tick() } as never);

    const output = syntheticGrepOutput(19_123);
    for (const message of turnMessages(
      {
        user: "Find every deterministic grep hit in the repository.",
        toolName: "grep",
        toolArgs: { pattern: "deterministic-grep-hit" },
        toolOutput: output,
        closing: "The grep results are archived; ask me to recall them when needed.",
      },
      "call_b0",
    )) {
      sm.appendMessage(message as never);
    }

    const before = projectionBytes(sm);

    // Real hygiene pipeline over the real projection (same items the
    // turn_end handler would classify).
    const projection = sm.buildSessionProjection();
    const candidates = projection.entries.flatMap((projected) =>
      projected.messages
        .filter((m) => (m as { role?: string }).role === "toolResult")
        .map((m) => {
          const text = (m as { content?: Array<{ type: string; text?: string }> }).content
            ?.filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
          return {
            item: {
              entryId: projected.sourceEntry.id,
              role: "toolResult",
              toolName: (m as { toolName?: string }).toolName,
              isError: (m as { isError?: boolean }).isError,
              ts: (m as { timestamp?: number }).timestamp,
              chars: text?.length ?? 0,
            },
            content: text ?? "",
          };
        }),
    );
    const plan = await planHygiene(SESSION_ID, candidates, store, POLICY);
    if (plan.entries.length !== 1) {
      throw new Error(`scenario B expected exactly one archive, got ${plan.entries.length}`);
    }
    const entry = plan.entries[0]!;
    sm.appendContextEdit(
      entry.targetId,
      { content: [{ type: "text", text: entry.replacement }] } as never,
    );
    const after = projectionBytes(sm);

    // Evidence integrity: the archived bytes must verify and match exactly.
    const recalled = await store.get(entry.ref, { sessionId: SESSION_ID });
    const recallMatches = createHash("sha256").update(recalled, "utf8").digest("hex") ===
      createHash("sha256").update(output, "utf8").digest("hex");
    const markerParses = parseMarker(entry.replacement.split("\n")[0] ?? "");

    const serialized = [before.json, after.json];
    const projections = serialized.map((json) => ({
      bytes: Buffer.byteLength(json, "utf8"),
      estimatedTokens: estimateTextTokens(json).value,
    }));
    const series = compareProjectionSeries(serialized);
    return {
      scenario: "B",
      description: "one 19,123-char read-only grep output archived to evidence and replaced",
      turns: 2, // before-hygiene and after-hygiene projections of the same turn
      projections,
      consecutive: {
        comparisons: series.comparisons.map((c) => ({
          commonPrefixBytes: c.commonPrefixBytes,
          commonPrefixRatio: c.commonPrefixRatio,
          firstChangedByte: c.firstChangedByte,
        })),
        averageStablePrefixRatio: series.averageStablePrefixRatio,
        finalCommonPrefixBytes: series.finalCommonPrefixBytes,
      },
      counters: {
        modelVisibleToolCalls: 1,
        toolResultOriginalBytes: Buffer.byteLength(output, "utf8"),
        toolResultModelVisibleBytes: Buffer.byteLength(entry.replacement, "utf8"),
        archives: plan.entries.length,
        recalls: 1,
        compactions: 0,
        contextGenerations: 1,
      },
      extra: {
        evidenceRetainedBytes: entry.ref.bytes,
        recallExactMatch: recallMatches,
        markerParses: markerParses !== undefined,
        markerFormat: entry.replacement.split("\n")[0],
        markerHeadPreviewBytes: Buffer.byteLength(
          (entry.replacement.split("\n").slice(1).join("\n") ?? ""),
          "utf8",
        ),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scenario C — repeated unchanged state (same output exposed repeatedly)
// ---------------------------------------------------------------------------
async function scenarioC(): Promise<ScenarioResult> {
  resetClock();
  const sm = newSession();
  sm.appendMessage({ role: "system", content: SYSTEM_PROMPT, timestamp: tick() } as never);

  const stableOutput = syntheticFile(40, "stable");
  const serialized: string[] = [];
  for (let t = 0; t < 4; t++) {
    for (const message of turnMessages(
      {
        user: `Re-check the current state of module stable (check ${t + 1}).`,
        toolName: "read",
        toolArgs: { path: "src/stable.ts" },
        toolOutput: stableOutput,
        closing: "Module stable is unchanged; state matches the previous check.",
      },
      `call_c${t}`,
    )) {
      sm.appendMessage(message as never);
    }
    serialized.push(projectionBytes(sm).json);
  }

  const projections = serialized.map((json) => ({
    bytes: Buffer.byteLength(json, "utf8"),
    estimatedTokens: estimateTextTokens(json).value,
  }));
  const series = compareProjectionSeries(serialized);
  return {
    scenario: "C",
    description:
      "four turns re-reading identical state; only the new turn should differ (appended)",
    turns: 4,
    projections,
    consecutive: {
      comparisons: series.comparisons.map((c) => ({
        commonPrefixBytes: c.commonPrefixBytes,
        commonPrefixRatio: c.commonPrefixRatio,
        firstChangedByte: c.firstChangedByte,
      })),
      averageStablePrefixRatio: series.averageStablePrefixRatio,
      finalCommonPrefixBytes: series.finalCommonPrefixBytes,
    },
    counters: {
      modelVisibleToolCalls: 4,
      toolResultOriginalBytes: 4 * Buffer.byteLength(stableOutput, "utf8"),
      archives: 0,
      recalls: 0,
      compactions: 0,
      contextGenerations: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool schema footprint (context-manager side; runtime side lives in its repo)
// ---------------------------------------------------------------------------
function toolSchemaFootprint(): Record<string, unknown> {
  const recall = createRecallTool({
    store: {} as never,
    sessionId: () => SESSION_ID,
    branchEntryIds: () => new Set<string>(),
    refs: () => new Map(),
  }) as unknown as {
    name: string;
    description: string;
    parameters: unknown;
    defaultActive?: boolean;
    exposure?: string;
  };
  const schemaBytes = Buffer.byteLength(JSON.stringify(recall.parameters) ?? "", "utf8");
  const descriptionBytes = Buffer.byteLength(recall.description, "utf8");
  return {
    tools: [
      {
        name: recall.name,
        exposure: recall.exposure ?? "direct",
        defaultActive: recall.defaultActive ?? true,
        schemaBytes,
        descriptionBytes,
        totalBytes: schemaBytes + descriptionBytes,
      },
    ],
    totalSchemaBytes: schemaBytes,
    activeToolCount: 1, // baseline: recall is activated on registration
  };
}

// ---------------------------------------------------------------------------

const result = {
  bench: "pi-context-manager agent efficiency",
  piCompatibility: "pinned by scripts/check-pi-version.mjs",
  serialization: "JSON.stringify(buildSessionProjection().messages), UTF-8 bytes",
  tokenFigures: "estimated (chars/4) — never provider-reported",
  scenarios: {
    A: await scenarioA(),
    B: await scenarioB(),
    C: await scenarioC(),
  },
  toolSchema: toolSchemaFootprint(),
  jobMechanism: {
    codeJobStatusPollsRequired: 0,
    codeJobWaitCalls: 1,
    note: "event-driven wait; status is not needed to await completion (measured in pi-code-runtime-next bench)",
  },
};

// Sanity: nothing in this bench may consume live randomness — two identical
// runs must produce byte-identical JSON. Enforced by the meta-repo runner.
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

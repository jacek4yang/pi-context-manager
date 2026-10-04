import { test } from "node:test";
import assert from "node:assert/strict";
import { DeterministicEngine } from "../src/engines/deterministic.ts";
import { createProviderNativeEngine } from "../src/engines/provider-native.ts";
import {
  CompactionCancelled,
  EngineSelector,
  NoEngineError,
  StagedCompaction,
} from "../src/engines/selector.ts";
import type {
  CompactionEngine,
  CompactionPlan,
  ContextItem,
  RuntimeContext,
} from "../src/core/types.ts";

const CTX: RuntimeContext = {
  sessionId: "s1",
  leafId: "leaf1",
  model: { provider: "p", modelId: "m" },
  tokensUsed: undefined,
  contextWindow: undefined,
};
const INPUT: CompactionPlan["input"] = [
  { role: "user", text: "fix the failing tests" },
  { role: "toolResult", toolName: "bash", isError: true, text: "command not found: tst" },
  { role: "toolResult", toolName: "read", text: "src/a.ts\nline2\nline3" },
];

function candidates(): ContextItem[] {
  return INPUT.map((item, i) => ({
    entryId: `e${i}`,
    role: item.role,
    toolName: item.toolName,
    isError: item.isError,
    chars: item.text.length,
  }));
}

function makeEngine(
  id: CompactionEngine["id"],
  behavior: Partial<Pick<CompactionEngine, "probe" | "compact">>,
): CompactionEngine {
  const plan: CompactionPlan = {
    engine: "generic-verified" as const,
    sessionId: CTX.sessionId,
    summarizeEntryIds: [],
    firstKeptEntryId: "leaf1",
    tokensBefore: { value: 1, source: "estimated" },
    prefixStable: true,
    input: INPUT,
  };
  return {
    id,
    probe: () => ({ supported: true }),
    plan: () => plan,
    compact: async () => ({ engine: "generic-verified" as const, summary: "", details: {} }),
    ...behavior,
  };
}

test("deterministic engine records tool evidence and errors without a model (C6)", async () => {
  const engine = new DeterministicEngine();
  const plan = engine.plan(CTX, INPUT);
  const result = await engine.compact(plan);
  assert.ok(result.summary.includes("## Deterministic compaction record"));
  assert.ok(result.summary.includes("read ×1"));
  assert.ok(result.summary.includes("command not found"));
  assert.equal(result.details.nativeCheckpoint, undefined);
});

test("probe-unsupported engines are skipped and the next engine applies (C11)", async () => {
  const native = createProviderNativeEngine({
    probe: () => ({ supported: false, reason: "provider api lacks native compaction" }),
    request: async () => {
      throw new Error("must never be called when probe refuses");
    },
  });
  const fallback = new DeterministicEngine();
  const selector = new EngineSelector([native, fallback]);
  const outcome = await selector.run(CTX, candidates(), INPUT, "leaf1");
  assert.equal(outcome.result.engine, "deterministic");
  assert.deepEqual(
    outcome.attempts.map((a) => a.outcome),
    ["probe-unsupported", "applied"],
  );
});

test("an engine error falls through to the next engine (C8)", async () => {
  const failing = makeEngine("hybrid", {
    compact: async () => {
      throw new Error("engine exploded");
    },
  });
  const selector = new EngineSelector([failing, new DeterministicEngine()]);
  const outcome = await selector.run(CTX, candidates(), INPUT, "leaf1");
  assert.equal(outcome.result.engine, "deterministic");
  assert.deepEqual(outcome.attempts[0]!.outcome, "error");
});

test("cancellation never commits a partial result (C9)", async () => {
  const aborter = new AbortController();
  const slow = makeEngine("hybrid", {
    compact: async (plan) => {
      plan.signal?.throwIfAborted();
      aborter.abort();
      plan.signal?.throwIfAborted();
      return { engine: "generic-verified", summary: "half done", details: {} };
    },
  });
  const selector = new EngineSelector([slow]);
  await assert.rejects(
    () => selector.run(CTX, candidates(), INPUT, "leaf1", aborter.signal),
    CompactionCancelled,
  );
});

test("a native engine that returns an empty summary is refused, never faked", async () => {
  const native = createProviderNativeEngine({
    probe: () => ({ supported: true }),
    request: async () => ({ summary: "", checkpoint: { encrypted: true } }),
  });
  const selector = new EngineSelector([native]);
  await assert.rejects(() => selector.run(CTX, candidates(), INPUT, "leaf1"), /refusing to fake/);
});

test("when every engine fails the selector refuses and state is preserved", async () => {
  const failing1 = makeEngine("hybrid", {
    compact: async () => {
      throw new Error("x");
    },
  });
  const failing2 = makeEngine("deterministic", {
    compact: async () => {
      throw new Error("y");
    },
  });
  const selector = new EngineSelector([failing1, failing2]);
  await assert.rejects(() => selector.run(CTX, candidates(), INPUT, "leaf1"), NoEngineError);
});

test("staged compaction is invalidated by a model switch (C10)", () => {
  const staged = new StagedCompaction<{ plan: string }>();
  staged.stage("s1", "provider-a/model-1", { plan: "p1" });
  assert.deepEqual(staged.take("s1", "provider-a/model-1"), { plan: "p1" });
  staged.stage("s2", "provider-a/model-1", { plan: "p2" });
  // Model switched between staging and taking: the staged plan is unusable.
  assert.equal(staged.take("s2", "provider-b/model-2"), undefined);
  staged.stage("s3", "provider-a/model-1", { plan: "p3" });
  assert.equal(staged.invalidateModel("provider-a/model-1"), 1);
  assert.equal(staged.size, 0);
});

test("native request honors the injected timeout bound", async () => {
  const native = createProviderNativeEngine({
    probe: () => ({ supported: true }),
    timeoutMs: 20,
    request: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ summary: "too late", checkpoint: null }), 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      throw new Error("unreachable");
    },
  });
  const selector = new EngineSelector([native]);
  await assert.rejects(() => selector.run(CTX, candidates(), INPUT, "leaf1"), /aborted/);
});

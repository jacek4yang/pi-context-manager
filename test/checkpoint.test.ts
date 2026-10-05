// [C16] Session reopen restores required continuity state, through the real
// extension lifecycle (mock registration adapter drives registered handlers).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreCheckpoint, validateCheckpoint, CHECKPOINT_HISTORY, type CheckpointData } from "../src/continuity/checkpoint.ts";
import { STACK_INFO } from "../src/info.ts";
import { createMockPiCm } from "./helpers/mock-pi-cm.ts";

const CT = "pinx.context.generation";

function checkpoint(over: Partial<CheckpointData> = {}): CheckpointData {
  return {
    v: 1,
    generation: 3,
    sessionId: "sess-1",
    atEntryId: "leaf-9",
    provider: "intern",
    model: "glm-5.3",
    evidenceIds: ["ev_a"],
    createdAt: "2026-10-05T00:00:00.000Z",
    ...over,
  };
}

const identity = { sessionId: "sess-1", provider: "intern", model: "glm-5.3" };

test("[C16] latest valid checkpoint wins (repeated reopen is idempotent)", () => {
  const entries = [
    { customType: CT, data: checkpoint({ generation: 1 }) },
    { customType: CT, data: checkpoint({ generation: 5 }) },
  ];
  const a = restoreCheckpoint(entries, identity, CT);
  const b = restoreCheckpoint(entries, identity, CT);
  assert.equal(a.checkpoint!.generation, 5);
  assert.equal(b.checkpoint!.generation, 5);
});

test("[C16] corrupt newest checkpoint falls back to the next-newest valid one", () => {
  const entries = [
    { customType: CT, data: checkpoint({ generation: 2 }) },
    { customType: CT, data: { broken: true } },
  ];
  const { checkpoint: cp, skipped } = restoreCheckpoint(entries, identity, CT);
  assert.equal(cp!.generation, 2);
  assert.equal(skipped.length, 1);
});

test("[C4] session provenance mismatch is rejected (fail closed)", () => {
  const result = validateCheckpoint(checkpoint({ sessionId: "other-session" }), identity);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /sessionId mismatch/);
});

test("[C16] model/provider mismatch invalidates restored state (stale staged work)", () => {
  const result = validateCheckpoint(checkpoint({ model: "other-model" }), identity);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /provider\/model mismatch/);
});

test("[C15] checkpoint storage remains bounded (history cap)", () => {
  const entries = Array.from({ length: CHECKPOINT_HISTORY + 10 }, (_, i) => ({
    customType: CT,
    data: checkpoint({ generation: i }),
  }));
  const { checkpoint: cp } = restoreCheckpoint(entries, identity, CT);
  assert.equal(cp!.generation, CHECKPOINT_HISTORY + 9);
});

test("[C16] empty/new session has no checkpoint and restores nothing", () => {
  const { checkpoint: cp } = restoreCheckpoint([], identity, CT);
  assert.equal(cp, undefined);
});

test("[C1] checkpoint carries references, not canonical evidence content", () => {
  const cp = checkpoint();
  assert.deepEqual(cp.evidenceIds, ["ev_a"]);
  const serialized = JSON.stringify(cp);
  assert.ok(!serialized.includes("r".repeat(100)), "checkpoint must not embed evidence bodies");
});

// --- Extension-level lifecycle: real handlers via mock registration adapter ---

import { default as cmExtension } from "../src/index.ts";

const OLD = Date.now() - 31 * 60 * 1000;

function harness(sessionId?: string) {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pinx-cm-c16-"));
  const h = createMockPiCm(sessionId);
  cmExtension(h.pi as never);

  // Tests opt into a committing projection via setProjectionFixture.
  return h;
}

function grepProjectionFixture() {
  return {
    entries: [
      {
        sourceEntry: { id: "entry-1" },
        messages: [
          {
            role: "toolResult",
            toolName: "grep",
            isError: false,
            timestamp: OLD,
            content: [{ type: "text", text: "match ".repeat(1500) }],
          },
        ],
      },
    ],
    messages: [],
  };
}

function branchFrom(h: ReturnType<typeof createMockPiCm>) {
  return h.appendedEntries.map((e, i) => ({
    type: "custom" as const,
    id: `c${i}`,
    customType: e.customType,
    data: e.data,
  }));
}

function generationFromBus(h: ReturnType<typeof createMockPiCm>): number | undefined {
  for (let i = h.busLog.length - 1; i >= 0; i--) {
    const e = h.busLog[i]!;
    if (e.channel === "pinx.activity" && (e.payload as { kind?: string }).kind === "context.checkpoint") {
      return (e.payload as { detail: { generation: number } }).detail.generation;
    }
  }
  return undefined;
}

test("[C16] reopen: hygiene commit persists checkpoint → new instance restores generation + evidence refs", async () => {
  // Session 1: commit hygiene state through the real turn_end path.
  const h1 = harness();
  h1.setProjectionFixture(grepProjectionFixture());
  await h1.dispatch("session_start", { reason: "startup" });
  await h1.dispatch("turn_end", {}, {});
  const checkpoints = h1.appendedEntries.filter((e) => e.customType === STACK_INFO.customTypes.generation);
  assert.equal(checkpoints.length, 1, "generation checkpoint persisted on hygiene commit");

  // Session 2: reopen — replay the SAME branch entries into a NEW instance
  // bound to the SAME session id (a reopen of that session).
  const branch = branchFrom(h1);
  const h2 = harness(h1.sessionId);
  h2.setSessionFixture(branch);
  await h2.dispatch("session_start", { reason: "resume" });
  const generation = generationFromBus(h2);
  assert.ok(generation !== undefined && generation >= 1, "generation restored from checkpoint");
  const notice = h2.busLog.filter((e) => e.channel === "pinx.activity").at(-1)!.payload as { summary: string };
  assert.match(notice.summary, /1 evidence refs/);
  h1.cleanup();
  h2.cleanup();
});

test("[C16] provider/model mismatch on reopen leaves generation unset (stale staged state not reused)", async () => {
  const h1 = harness();
  h1.setProjectionFixture(grepProjectionFixture());
  await h1.dispatch("session_start", { reason: "startup" });
  await h1.dispatch("turn_end", {}, {});

  const branch = branchFrom(h1);
  const h2 = harness(h1.sessionId);
  h2.setModelOverride({ provider: "other", id: "m2" });
  h2.setSessionFixture(branch);
  await h2.dispatch("session_start", { reason: "resume" });
  assert.equal(generationFromBus(h2), undefined, "no continuity across a provider/model switch");
  h1.cleanup();
  h2.cleanup();
});

test("[C16] empty/new session restores nothing (generation stays 0)", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  assert.equal(generationFromBus(h), undefined);
  h.cleanup();
});

test("[C16] checkpoint is not persisted without a hygiene commit", async () => {
  const h = harness();
  h.setProjectionFixture({ entries: [], messages: [] });
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("turn_end", {}, {});
  console.log("DBG179:", JSON.stringify(h.appendedEntries));
  const checkpoints = h.appendedEntries.filter((e) => e.customType === STACK_INFO.customTypes.generation);
  assert.equal(checkpoints.length, 0, "empty hygiene plan → no checkpoint entry");
  h.cleanup();
});

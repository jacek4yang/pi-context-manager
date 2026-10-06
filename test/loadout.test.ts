// Loadout + projection-stability gates for the cacheability phase.
//
// [C-LOAD]  deterministic recall activation (no capability loss, no early
//           schema bytes on fresh sessions)
// [C-STABLE] semantically unchanged projections are byte-identical across
//           pipeline runs; markers are timestamp-free and parse round-trip
// [C-WS]    working-set annotation is deterministic and conservative

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { formatMarker, parseMarker } from "../src/core/evidence.ts";
import { classifyItem } from "../src/core/classify.ts";
import { DEFAULT_HYGIENE_POLICY, type ContextItem } from "../src/core/types.ts";
import { createRecallTool, RECALL_TOOL_NAME } from "../src/recall/tool.ts";
import { STACK_INFO } from "../src/info.ts";
import { default as cmExtension } from "../src/index.ts";
import { createMockPiCm } from "./helpers/mock-pi-cm.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { planHygiene } from "../src/hygiene/hygiene.ts";
import { T0, syntheticFile } from "../bench/fixtures.ts";

const OLD = Date.now() - 31 * 60 * 1000;

function harness(sessionId?: string) {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pinx-cm-load-"));
  const h = createMockPiCm(sessionId);
  cmExtension(h.pi as never);
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

test("[C-LOAD] recall is registered but NOT activated on a fresh session", async () => {
  const h = harness();
  assert.ok(h.registeredTools.includes(RECALL_TOOL_NAME), "recall tool registered");
  await h.dispatch("session_start", { reason: "startup" });
  assert.equal(h.activeToolCalls.length, 0, "no activation without evidence");
  h.cleanup();
});

test("[C-LOAD] session_start with restored evidence refs activates recall", async () => {
  const h1 = harness();
  h1.setProjectionFixture(grepProjectionFixture());
  await h1.dispatch("session_start", { reason: "startup" });
  await h1.dispatch("turn_end", {}, {});
  const evidenceEntries = h1.appendedEntries.filter(
    (e) => e.customType === STACK_INFO.customTypes.evidence,
  );
  assert.ok(evidenceEntries.length > 0, "archive committed");

  const branch = branchFrom(h1);
  const h2 = harness(h1.sessionId);
  h2.setSessionFixture(branch);
  await h2.dispatch("session_start", { reason: "resume" });
  const last = h2.activeToolCalls.at(-1);
  assert.ok(last?.includes(RECALL_TOOL_NAME), "recall activated on reopen with evidence");
  h1.cleanup();
  h2.cleanup();
});

test("[C-LOAD] turn_end archive commit activates recall for the next turn", async () => {
  const h = harness();
  h.setProjectionFixture(grepProjectionFixture());
  await h.dispatch("session_start", { reason: "startup" });
  await h.dispatch("turn_end", {}, {});
  const last = h.activeToolCalls.at(-1);
  assert.ok(last?.includes(RECALL_TOOL_NAME), "recall activated after first archive");
  assert.ok(last?.includes("read") && last?.includes("grep"), "existing tools preserved");
  h.cleanup();
});

test("[C-LOAD] PINX_RECALL_ALWAYS=1 keeps recall active even without evidence", async () => {
  process.env.PINX_RECALL_ALWAYS = "1";
  try {
    const h = harness();
    await h.dispatch("session_start", { reason: "startup" });
    const last = h.activeToolCalls.at(-1);
    assert.ok(last?.includes(RECALL_TOOL_NAME), "operator override forces activation");
    h.cleanup();
  } finally {
    delete process.env.PINX_RECALL_ALWAYS;
  }
});

test("[C-STABLE] archive marker is timestamp-free and parses round-trip", () => {
  const head = "src/a.ts:1: first match line\nsecond line";
  const marker = formatMarker({ kind: "grep", chars: 19_123, ref: "ev_" + "0".repeat(32), head });
  // Only what the model needs: kind, size, ref, head preview. No timestamp,
  // no session id, no volatile status.
  assert.equal(
    marker.split("\n")[0],
    `[Archived grep output · 19123 chars · ref ${"ev_" + "0".repeat(32)}]`,
  );
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(marker), "no ISO timestamp in marker");
  assert.ok(!/T\d{2}:\d{2}/.test(marker), "no time-of-day in marker");
  const parsed = parseMarker(marker);
  assert.equal(parsed?.kind, "grep");
  assert.equal(parsed?.chars, 19_123);
});

test("[C-STABLE] double hygiene run produces byte-identical projections", async () => {
  const content = syntheticFile(120, "stable"); // large enough to archive
  const run = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "pinx-cm-det-"));
    try {
      const sm = SessionManager.inMemory();
      sm.appendMessage({
        role: "system",
        content: "determinism gate",
        timestamp: T0,
      } as never);
      sm.appendMessage({ role: "user", content: "read the module", timestamp: T0 + 1 } as never);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_x", name: "read", arguments: { path: "m.ts" } }],
        api: "openai-completions",
        provider: "bench",
        model: "bench-deterministic",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: T0 + 2,
      } as never);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_x",
        toolName: "read",
        content: [{ type: "text", text: content }],
        isError: false,
        timestamp: T0 + 3,
      } as never);
      const projection = sm.buildSessionProjection();
      const entryId = projection.entries.at(-1)!.sourceEntry.id;
      const store = new EvidenceStore(join(dir, "ev"), {
        idFactory: () => `ev_${"0".repeat(32)}`,
      });
      const plan = await planHygiene(
        "bench-session-0001",
        [
          {
            item: {
              entryId,
              role: "toolResult",
              toolName: "read",
              isError: false,
              ts: T0 + 3,
              chars: content.length,
            },
            content,
          },
        ],
        store,
        DEFAULT_HYGIENE_POLICY,
        { minChars: 4_000, maxEditsPerTurn: 8 },
      );
      assert.equal(plan.entries.length, 1);
      sm.appendContextEdit(plan.entries[0]!.targetId, {
        content: [{ type: "text", text: plan.entries[0]!.replacement }],
      } as never);
      return JSON.stringify(sm.buildSessionProjection().messages);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const a = await run();
  const b = await run();
  assert.equal(a, b, "semantically unchanged projection is byte-identical across runs");
});

function item(partial: Partial<ContextItem>): ContextItem {
  return { entryId: "e1", role: "toolResult", chars: 100, ...partial };
}

test("[C-WS] working-set annotation is deterministic and conservative", () => {
  const now = Date.now();
  const policy = DEFAULT_HYGIENE_POLICY;

  // Substance and safety: must-keep, regardless of anything else.
  assert.equal(classifyItem(item({ role: "user" }), policy, now).workingSet, "must-keep");
  assert.equal(classifyItem(item({ role: "assistant" }), policy, now).workingSet, "must-keep");
  assert.equal(
    classifyItem(item({ toolName: "read", isError: true, ts: OLD }), policy, now).workingSet,
    "must-keep",
  );
  assert.equal(
    classifyItem(item({ toolName: "edit", ts: OLD }), policy, now).workingSet,
    "must-keep",
  );
  assert.equal(
    classifyItem(item({ toolName: "ffgrep", ts: OLD }), policy, now).workingSet,
    "must-keep",
    "unknown tools stay must-keep (fail-closed default)",
  );

  // Recent successful read-only output: active (protected by C5).
  assert.equal(
    classifyItem(item({ toolName: "read", ts: now - 1000 }), policy, now).workingSet,
    "active",
  );

  // Old successful read-only output: the primary archive candidate.
  assert.equal(
    classifyItem(item({ toolName: "grep", ts: OLD }), policy, now).workingSet,
    "archivable",
  );

  // Annotation never overrides disposition: active items stay protected.
  const recent = classifyItem(item({ toolName: "read", ts: now - 1000 }), policy, now);
  assert.equal(recent.disposition, "protected");
  assert.equal(recent.workingSet, "active");
});

test("[C-LOAD] recall definition carries defaultActive:false and direct exposure semantics", () => {
  const tool = createRecallTool({
    store: {} as never,
    sessionId: () => "s",
    branchEntryIds: () => new Set<string>(),
    refs: () => new Map(),
  }) as unknown as { name: string; defaultActive?: boolean };
  assert.equal(tool.name, RECALL_TOOL_NAME);
  assert.equal(tool.defaultActive, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "../src/evidence/store.ts";
import { planHygiene, planHygieneWithClassifier } from "../src/hygiene/hygiene.ts";
import { DEFAULT_HYGIENE_POLICY, type ContextItem } from "../src/core/types.ts";
import type { HygieneCandidate } from "../src/hygiene/hygiene.ts";

const NOW = 1_000_000_000_000;
const OLD = NOW - DEFAULT_HYGIENE_POLICY.recentWindowMs - 1000;

function candidate(entryId: string, toolName: string, chars: number, ts = OLD): HygieneCandidate {
  const item: ContextItem = { entryId, role: "toolResult", toolName, chars, ts, isError: false };
  return { item, content: "x".repeat(Math.max(chars, 1)) };
}

function tempStore(): { store: EvidenceStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pinx-hygiene-"));
  return { store: new EvidenceStore(dir), dir };
}

test("[C15] eligible old large outputs produce bounded marker drafts with refs", async () => {
  const { store, dir } = tempStore();
  try {
    const plan = await planHygiene(
      "s1",
      [candidate("e1", "grep", 9000)],
      store,
      DEFAULT_HYGIENE_POLICY,
      { minChars: 4000, maxEditsPerTurn: 8 },
      NOW,
    );
    assert.equal(plan.entries.length, 1);
    const entry = plan.entries[0]!;
    assert.equal(entry.targetId, "e1");
    assert.match(entry.replacement, /^\[Archived grep output · 9000 chars · ref ev_[0-9a-f]{32}\]/);
    assert.equal(entry.ref.bytes, 9000);
    // Evidence must be retrievable immediately after planning (C2).
    const content = await store.get(entry.ref, { sessionId: "s1", entryId: "e1" });
    assert.equal(content.length, 9000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[C11] protected and small items are skipped with reasons (C5/C6)", async () => {
  const { store, dir } = tempStore();
  try {
    const plan = await planHygiene(
      "s1",
      [
        candidate("e1", "bash", 9000),
        candidate("e2", "read", 100),
        candidate("e3", "read", 9000, NOW - 10),
      ],
      store,
      DEFAULT_HYGIENE_POLICY,
      { minChars: 4000, maxEditsPerTurn: 8 },
      NOW,
    );
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.protectedCount, 2);
    assert.ok(plan.skipped.some((s) => s.entryId === "e2" && s.reason.includes("below threshold")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[C15] per-turn edit budget bounds the plan", async () => {
  const { store, dir } = tempStore();
  try {
    const candidates = Array.from({ length: 20 }, (_, i) => candidate(`e${i}`, "ls", 5000));
    const plan = await planHygiene(
      "s1",
      candidates,
      store,
      DEFAULT_HYGIENE_POLICY,
      { minChars: 4000, maxEditsPerTurn: 8 },
      NOW,
    );
    assert.equal(plan.entries.length, 8);
    assert.ok(plan.skipped.length >= 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[C7] evidence write failure aborts the whole batch (C7)", async () => {
  const failing = {
    put: async () => {
      throw new Error("disk full");
    },
  } as unknown as EvidenceStore;
  const classify = () => ({
    category: "tool-result" as const,
    disposition: "eligible" as const,
    reason: "test",
  });
  const candidates = [candidate("e1", "grep", 9000), candidate("e2", "grep", 9000)];
  // One failed archive aborts everything; nothing is partially planned.
  await assert.rejects(() => planHygieneWithClassifier("s1", candidates, failing, classify));
});

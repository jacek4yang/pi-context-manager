import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyItem, allEligible } from "../src/core/classify.ts";
import { DEFAULT_HYGIENE_POLICY } from "../src/core/types.ts";
import {
  estimateTextTokens,
  estimateTokens,
  pressure,
  providerTokens,
} from "../src/core/estimate.ts";
import { formatMarker, parseMarker } from "../src/core/evidence.ts";
import type { ContextItem } from "../src/core/types.ts";

const NOW = 1_000_000_000_000;
const OLD = NOW - DEFAULT_HYGIENE_POLICY.recentWindowMs - 1000;
const RECENT = NOW - 1000;

function item(overrides: Partial<ContextItem>): ContextItem {
  return { entryId: "e1", role: "toolResult", chars: 100, ts: OLD, ...overrides };
}

test("user/system/assistant content is always protected", () => {
  for (const role of ["system", "user", "assistant", "custom"]) {
    const c = classifyItem(item({ role, ts: OLD }), DEFAULT_HYGIENE_POLICY, NOW);
    assert.equal(c.disposition, "protected", role);
  }
});

test("[C6] error tool results are never eligible (C6)", () => {
  const c = classifyItem(item({ toolName: "read", isError: true }), DEFAULT_HYGIENE_POLICY, NOW);
  assert.equal(c.disposition, "protected");
  assert.ok(c.reason.includes("C6"));
});

test("mutating tools are never eligible", () => {
  for (const toolName of ["write", "edit", "bash", "code", "python", "node"]) {
    const c = classifyItem(item({ toolName, ts: OLD }), DEFAULT_HYGIENE_POLICY, NOW);
    assert.equal(c.disposition, "protected", toolName);
    assert.ok(c.reason.includes("mutating"));
  }
});

test("unknown tool output is unsafe by default (protect)", () => {
  const c = classifyItem(item({ toolName: "mystery-tool", ts: OLD }), DEFAULT_HYGIENE_POLICY, NOW);
  assert.equal(c.disposition, "protected");
});

test("old successful read-only output is eligible", () => {
  for (const toolName of ["read", "grep", "find", "ls"]) {
    const c = classifyItem(item({ toolName, ts: OLD }), DEFAULT_HYGIENE_POLICY, NOW);
    assert.equal(c.disposition, "eligible", toolName);
  }
});

test("[C5] recent work stays protected (C5)", () => {
  const c = classifyItem(item({ toolName: "read", ts: RECENT }), DEFAULT_HYGIENE_POLICY, NOW);
  assert.equal(c.disposition, "protected");
  assert.ok(c.reason.includes("C5"));
});

test("items without timestamps fail safe to protected", () => {
  const c = classifyItem(item({ toolName: "read", ts: undefined }), DEFAULT_HYGIENE_POLICY, NOW);
  assert.equal(c.disposition, "protected");
});

test("unknown roles fail safe to protected", () => {
  const c = classifyItem(
    item({ role: "weird" as ContextItem["role"] }),
    DEFAULT_HYGIENE_POLICY,
    NOW,
  );
  assert.equal(c.disposition, "protected");
});

test("allEligible requires every item to pass", () => {
  const ok = [
    item({ entryId: "a", toolName: "grep", ts: OLD }),
    item({ entryId: "b", toolName: "ls", ts: OLD }),
  ];
  const bad = [...ok, item({ entryId: "c", toolName: "bash", ts: OLD })];
  assert.equal(allEligible(ok, DEFAULT_HYGIENE_POLICY, NOW), true);
  assert.equal(allEligible(bad, DEFAULT_HYGIENE_POLICY, NOW), false);
});

test("estimates are labeled estimated and never claim provider numbers", () => {
  const est = estimateTextTokens("x".repeat(400));
  assert.equal(est.value, 100);
  assert.equal(est.source, "estimated");
  const prov = providerTokens(212_000);
  assert.equal(prov.source, "provider-reported");
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-5), 0);
});

test("pressure is undefined without a window and clamped otherwise", () => {
  assert.equal(pressure(undefined, 272_000), undefined);
  assert.equal(pressure(providerTokens(136_000), 272_000), 0.5);
  assert.equal(pressure(providerTokens(999_999), 272_000), 1);
});

test("[C1] evidence markers round-trip", () => {
  const line = formatMarker({ kind: "bash", chars: 18432, ref: "ev_01H", head: "$ npm test" });
  assert.ok(line.startsWith("[Archived bash output · 18432 chars · ref ev_01H]"));
  const parsed = parseMarker(line)!;
  assert.equal(parsed.kind, "bash");
  assert.equal(parsed.chars, 18432);
  assert.equal(parsed.ref, "ev_01H");
  assert.equal(parseMarker("not a marker"), undefined);
});

test("operator-declared extra archivable tools extend the allowlist explicitly", () => {
  const policy = {
    ...DEFAULT_HYGIENE_POLICY,
    archivableTools: new Set([...DEFAULT_HYGIENE_POLICY.archivableTools, "ffgrep"]),
  };
  const c = classifyItem(item({ toolName: "ffgrep", ts: OLD }), policy, NOW);
  assert.equal(c.disposition, "eligible");
  // Without the declaration the same tool stays protected (fail-safe default).
  const strict = classifyItem(item({ toolName: "ffgrep", ts: OLD }), DEFAULT_HYGIENE_POLICY, NOW);
  assert.equal(strict.disposition, "protected");
});

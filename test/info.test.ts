import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_INVARIANT, STACK_INFO } from "../src/info.ts";

test("customTypes live in the pinx namespace", () => {
  for (const t of Object.values(STACK_INFO.customTypes)) {
    assert.ok(t.startsWith("pinx.context."), t);
  }
});

test("the core invariant is recorded verbatim", () => {
  assert.equal(CORE_INVARIANT, "Recover before summarize. Summarize before discard.");
});

test("state root is isolated from the stable stack", () => {
  assert.equal(STACK_INFO.stateRoot, "pinx/context-manager");
});

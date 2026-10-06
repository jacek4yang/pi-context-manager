import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, EvidenceError } from "../src/evidence/store.ts";
import type { EvidenceRef } from "../src/core/evidence.ts";

function tempStore(): { store: EvidenceStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pinx-evidence-"));
  return { store: new EvidenceStore(dir), dir };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const CONTENT = "$ npm test\nPASS 143\nFAIL 0\n".repeat(10);

test("[C2] put/get roundtrip preserves content and records provenance (C2)", async () => {
  const { store, dir } = tempStore();
  try {
    const ref = await store.put({
      sessionId: "sess1",
      entryId: "ent1",
      kind: "bash",
      content: CONTENT,
    });
    assert.match(ref.id, /^ev_[0-9a-f]{32}$/);
    assert.equal(ref.bytes, Buffer.byteLength(CONTENT, "utf8"));
    const out = await store.get(ref, { sessionId: "sess1", entryId: "ent1" });
    assert.equal(out, CONTENT);
  } finally {
    cleanup(dir);
  }
});

test("[C14][C4] hash mismatch fails closed (C4/C14)", async () => {
  const { store, dir } = tempStore();
  try {
    const ref = await store.put({
      sessionId: "sess1",
      entryId: "ent1",
      kind: "bash",
      content: CONTENT,
    });
    const tampered: EvidenceRef = { ...ref, sha256: "0".repeat(64) };
    await assert.rejects(() => store.get(tampered, { sessionId: "sess1" }), EvidenceError);
  } finally {
    cleanup(dir);
  }
});

test("[C3] cross-session retrieval is refused (C3)", async () => {
  const { store, dir } = tempStore();
  try {
    const ref = await store.put({
      sessionId: "sessA",
      entryId: "ent1",
      kind: "read",
      content: CONTENT,
    });
    await assert.rejects(() => store.get(ref, { sessionId: "sessB" }), EvidenceError);
  } finally {
    cleanup(dir);
  }
});

test("[C3] entryId provenance mismatch fails closed (C3)", async () => {
  const { store, dir } = tempStore();
  try {
    const ref = await store.put({
      sessionId: "sessA",
      entryId: "entA",
      kind: "read",
      content: CONTENT,
    });
    await assert.rejects(
      () => store.get(ref, { sessionId: "sessA", entryId: "entB" }),
      EvidenceError,
    );
  } finally {
    cleanup(dir);
  }
});

test("[C15] oversize content is refused, not truncated (C15)", async () => {
  const { dir } = tempStore();
  try {
    const tiny = new EvidenceStore(dir, { maxBytes: 10 });
    await assert.rejects(
      () => tiny.put({ sessionId: "s", entryId: "e", kind: "generic", content: CONTENT }),
      EvidenceError,
    );
  } finally {
    cleanup(dir);
  }
});

test("[C4] malformed refs fail closed before touching the filesystem", async () => {
  const { store, dir } = tempStore();
  try {
    const evil = {
      v: 1,
      id: "../evil",
      sessionId: "s",
      entryId: "e",
      sha256: "0".repeat(64),
      bytes: 1,
      createdAt: "",
    } as EvidenceRef;
    await assert.rejects(() => store.get(evil, { sessionId: "s" }), EvidenceError);
  } finally {
    cleanup(dir);
  }
});

test("paginated retrieval honors offset/limit", async () => {
  const { store, dir } = tempStore();
  try {
    const ref = await store.put({ sessionId: "s", entryId: "e", kind: "bash", content: CONTENT });
    const page = await store.get(ref, { sessionId: "s", offset: 0, limit: 10 });
    assert.equal(page, CONTENT.slice(0, 10));
  } finally {
    cleanup(dir);
  }
});

test("dropSession removes evidence without touching other sessions", async () => {
  const { store, dir } = tempStore();
  try {
    const refA = await store.put({ sessionId: "a", entryId: "e", kind: "bash", content: CONTENT });
    const refB = await store.put({ sessionId: "b", entryId: "e", kind: "bash", content: CONTENT });
    await store.dropSession("a");
    await assert.rejects(() => store.get(refA, { sessionId: "a" }), EvidenceError);
    assert.equal(await store.get(refB, { sessionId: "b" }), CONTENT);
  } finally {
    cleanup(dir);
  }
});

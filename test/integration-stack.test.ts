// Cross-repository integration test (Phase E): context-manager evidence +
// code-runtime retained revisions + generation-recovery journal operating
// over one shared scenario. Imports sibling repos by relative path (test-only
// coupling; runtime import coupling remains forbidden per ARCHITECTURE.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore } from "../src/evidence/store.ts";
import { planHygiene } from "../src/hygiene/hygiene.ts";
import { DEFAULT_HYGIENE_POLICY, type ContextItem } from "../src/core/types.ts";
import { SourceStore } from "../../pi-code-runtime-next/src/runtime/store.ts";
import { Journal, recordHash } from "../../pi-generation-recovery-next/src/journal/journal.ts";
import { computeSafeFrontier, type ContentBlock } from "../../pi-generation-recovery-next/src/recovery/frontier.ts";

const NOW = Date.now();
const OLD = NOW - DEFAULT_HYGIENE_POLICY.recentWindowMs - 60_000;

test("integration: hygiene archive, retained source, and recovery journal agree on one session", async () => {
  const sessionId = "itest-session-1";
  const dir = mkdtempSync(join(tmpdir(), "pinx-integration-"));
  try {
    // 1. Context manager: archive a large old read output.
    const evidence = new EvidenceStore(join(dir, "evidence"));
    const item: ContextItem = { entryId: "entry-read-1", role: "toolResult", toolName: "read", chars: 9000, ts: OLD, isError: false };
    const plan = await planHygiene(sessionId, [{ item, content: "r".repeat(9000) }], evidence, DEFAULT_HYGIENE_POLICY, { minChars: 4000, maxEditsPerTurn: 8 }, NOW);
    assert.equal(plan.entries.length, 1);
    const ref = plan.entries[0]!.ref;
    assert.ok(await evidence.get(ref, { sessionId, entryId: ref.entryId }).then((c) => c.length === 9000));

    // 2. Code runtime: retain a source buffer revision for the fix.
    const sources = new SourceStore();
    sources.save("fix", "console.log('attempt')", "node");
    sources.patch("fix", 1, [{ kind: "replace", old: "attempt", new: "fixed" }]);
    assert.equal(sources.currentSource("fix").source, "console.log('fixed')");
    assert.equal(sources.get("fix").revisions[1]!.parentHash, sources.get("fix").revisions[0]!.hash);

    // 3. Recovery: journal the interrupted generation; tool calls never join
    //    the safe prefix, so no side effect can be duplicated (V3/V4/V5).
    const journal = new Journal(join(dir, "journal", `${sessionId}.jsonl`));
    const blocks: ContentBlock[] = [
      { kind: "text", complete: true, text: "Investigation complete. " },
      { kind: "toolCall", complete: true, toolName: "bash" },
    ];
    const frontier = computeSafeFrontier(blocks);
    const attempt = journal.append({
      kind: "attempt",
      attemptId: "att_it1",
      sessionId,
      frontier: frontier.frontier,
      safePrefix: frontier.safePrefix,
      evidenceRef: ref.id,
      buffer: { name: "fix", revision: sources.currentSource("fix").revision },
    });
    assert.equal(frontier.safePrefix.length, 1); // text only — the tool call is a barrier
    assert.equal(attempt.hash, recordHash(null, attempt.data));

    // 4. Cross-component identity: the evidence ref and buffer revision the
    //    journal points at must still resolve with matching provenance.
    assert.equal(ref.entryId, "entry-read-1");
    assert.equal(sources.currentSource("fix").revision, (attempt.data as { buffer: { revision: number } }).buffer.revision);
    const recovered = new Journal(join(dir, "journal", `${sessionId}.jsonl`));
    const replayed = recovered.read()[0]!;
    assert.equal((replayed.data as { attemptId: string }).attemptId, "att_it1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

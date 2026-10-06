// pinx_recall: bounded retrieval of archived evidence (Layer 7 recall).
// Fail-closed: provenance is re-checked against the live session branch, so a
// ref owned by a sibling branch or an off-branch entry is refused (C3).

import { Type } from "typebox";
import type { EvidenceStore } from "../evidence/store.ts";
import { EvidenceError } from "../evidence/store.ts";
import type { EvidenceRef } from "../core/evidence.ts";

export interface RecallDeps {
  store: EvidenceStore;
  sessionId: () => string;
  /** Entry ids currently reachable on the active branch. */
  branchEntryIds: () => ReadonlySet<string>;
  /** Archived refs recorded in session state, by ref id. */
  refs: () => ReadonlyMap<string, EvidenceRef>;
}

const PAGE_BYTES = 32 * 1024;

/** Model-visible tool name; the wiring activates it deterministically. */
export const RECALL_TOOL_NAME = "pinx_recall";

export function createRecallTool(deps: RecallDeps) {
  return {
    name: RECALL_TOOL_NAME,
    label: "Recall archived context",
    description:
      "Retrieve the original content archived by the context manager. " +
      "Refs appear in [Archived ... · ref ev_...] markers. Bounded pagination.",
    parameters: Type.Object({
      ref: Type.String({ description: "Evidence ref id from an archive marker" }),
      offset: Type.Optional(Type.Number({ description: "Byte offset into the archived content" })),
      limit: Type.Optional(
        Type.Number({ description: `Max bytes to return (default ${PAGE_BYTES})` }),
      ),
    }),
    // Deterministic loadout discipline: recall is useless until evidence
    // exists, so it is NOT activated on registration. The wiring activates
    // it exactly when archived refs exist (session_start restore or the
    // first archive commit) — no capability is ever lost, and fresh
    // sessions carry no recall schema bytes in the model-visible block.
    defaultActive: false,
    async execute(_toolCallId: string, params: { ref: string; offset?: number; limit?: number }) {
      const sessionId = deps.sessionId();
      const ref = deps.refs().get(params.ref);
      if (!ref) {
        throw new EvidenceError(`unknown evidence ref: ${params.ref}`);
      }
      if (!deps.branchEntryIds().has(ref.entryId)) {
        throw new EvidenceError("evidence is not reachable from the current session branch");
      }
      const content = await deps.store.get(ref, {
        sessionId,
        entryId: ref.entryId,
        offset: params.offset,
        limit: params.limit ?? PAGE_BYTES,
      });
      return {
        content: [{ type: "text" as const, text: content }],
        details: { ref: ref.id, entryId: ref.entryId, offset: params.offset ?? 0 },
      };
    },
  };
}

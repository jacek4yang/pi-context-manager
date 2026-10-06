// Continuity checkpoint (C16): the minimum durable state needed to restore
// deterministic context-management continuity after a session reopen.
//
// Policy (fail closed):
//   - the LATEST valid checkpoint wins; corrupt newest checkpoints are
//     skipped and the next-newest valid one is used;
//   - a checkpoint whose sessionId/provider/model does not match the
//     current identity is NOT restored (stale staged state);
//   - checkpoints never duplicate canonical evidence content — they carry
//     references (evidence ref ids) and generation counters only;
//   - storage is bounded: at most CHECKPOINT_HISTORY entries are replayed.

export const CHECKPOINT_HISTORY = 8;

export interface CheckpointData {
  v: 1;
  generation: number;
  sessionId: string;
  atEntryId: string;
  provider: string | undefined;
  model: string | undefined;
  /** Committed evidence refs recorded at checkpoint time (ids only). */
  evidenceIds: string[];
  createdAt: string;
}

export interface CheckpointIdentity {
  sessionId: string;
  provider: string | undefined;
  model: string | undefined;
}

export function validateCheckpoint(
  data: unknown,
  identity: CheckpointIdentity,
): { ok: true; data: CheckpointData } | { ok: false; reason: string } {
  if (typeof data !== "object" || data === null)
    return { ok: false, reason: "checkpoint data is not an object" };
  const c = data as Partial<CheckpointData>;
  if (c.v !== 1) return { ok: false, reason: "checkpoint schema version mismatch" };
  if (typeof c.generation !== "number" || !Number.isInteger(c.generation) || c.generation < 0) {
    return { ok: false, reason: "checkpoint generation invalid" };
  }
  if (c.sessionId !== identity.sessionId)
    return { ok: false, reason: "checkpoint sessionId mismatch" };
  // Provider/model mismatch: the checkpoint is stale for this identity —
  // not restored (stale staged work must not be reused across switches).
  if (c.provider !== identity.provider || c.model !== identity.model) {
    return { ok: false, reason: "checkpoint provider/model mismatch" };
  }
  if (!Array.isArray(c.evidenceIds)) return { ok: false, reason: "checkpoint evidenceIds invalid" };
  return { ok: true, data: data as CheckpointData };
}

/**
 * Rebuild continuity from replayed branch entries (oldest → newest).
 * The latest VALID checkpoint wins; corrupt ones fail closed individually
 * and are skipped (canonical history remains the source of truth).
 */
export function restoreCheckpoint(
  entries: Array<{ customType: string; data: unknown }>,
  identity: CheckpointIdentity,
  customType: string,
): { checkpoint: CheckpointData | undefined; skipped: Array<{ reason: string }> } {
  const skipped: Array<{ reason: string }> = [];
  const candidates = entries.filter((e) => e.customType === customType).slice(-CHECKPOINT_HISTORY);
  let checkpoint: CheckpointData | undefined;
  for (const entry of candidates) {
    const result = validateCheckpoint(entry.data, identity);
    if (result.ok) checkpoint = result.data;
    else skipped.push({ reason: result.reason });
  }
  return { checkpoint, skipped };
}

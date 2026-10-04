// Engine selection with safe fallback (C8/C9/C10/C11).
//
// Order is the configured engine chain. An engine whose probe says "no" is
// skipped (never faked); a thrown error falls through to the next engine;
// cancellation is never converted into a partial commit; if every engine
// fails the selector refuses — the caller keeps the pre-compaction state.

import type {
  CapabilityResult,
  CompactionEngine,
  CompactionPlan,
  CompactionResult,
  ContextItem,
  RuntimeContext,
} from "../core/types.ts";

export class NoEngineError extends Error {}
export class CompactionCancelled extends Error {}

export interface SelectorOutcome {
  result: CompactionResult;
  /** Probe/failure trace for observability. */
  attempts: Array<{
    engine: string;
    outcome: "applied" | "probe-unsupported" | "error" | "cancelled";
    detail?: string;
  }>;
}

export class EngineSelector {
  private engines: CompactionEngine[];

  constructor(engines: CompactionEngine[]) {
    if (engines.length === 0) throw new Error("EngineSelector needs at least one engine");
    this.engines = engines;
  }

  async run(
    ctx: RuntimeContext,
    candidates: ContextItem[],
    input: CompactionPlan["input"],
    firstKeptEntryId: string,
    signal?: AbortSignal,
  ): Promise<SelectorOutcome> {
    const attempts: SelectorOutcome["attempts"] = [];
    for (const engine of this.engines) {
      const probe: CapabilityResult = engine.probe(ctx);
      if (!probe.supported) {
        attempts.push({ engine: engine.id, outcome: "probe-unsupported", detail: probe.reason });
        continue;
      }
      const plan = engine.plan({ ...ctx, signal }, input);
      const bound: CompactionPlan = {
        ...plan,
        summarizeEntryIds:
          plan.summarizeEntryIds.length > 0
            ? plan.summarizeEntryIds
            : candidates.map((c) => c.entryId),
        firstKeptEntryId,
        signal,
      };
      try {
        const result = await engine.compact(bound);
        if (result.cancelled) {
          attempts.push({ engine: engine.id, outcome: "cancelled" });
          throw new CompactionCancelled(`compaction cancelled while running ${engine.id}`);
        }
        attempts.push({ engine: engine.id, outcome: "applied" });
        return { result, attempts };
      } catch (error) {
        if (error instanceof CompactionCancelled) throw error;
        if (signal?.aborted) throw new CompactionCancelled("compaction cancelled");
        attempts.push({ engine: engine.id, outcome: "error", detail: (error as Error).message });
      }
    }
    throw new NoEngineError(`all engines failed: ${JSON.stringify(attempts)}`);
  }
}

/**
 * Staged compaction tied to model identity (C10): a model/provider switch
 * invalidates staged work because capability assumptions no longer hold.
 */
export class StagedCompaction<PlanT> {
  private staged = new Map<string, { modelKey: string; plan: PlanT }>();

  stage(sessionId: string, modelKey: string, plan: PlanT): void {
    this.staged.set(sessionId, { modelKey, plan });
  }

  take(sessionId: string, modelKey: string): PlanT | undefined {
    const entry = this.staged.get(sessionId);
    if (!entry) return undefined;
    this.staged.delete(sessionId);
    if (entry.modelKey !== modelKey) return undefined; // invalidated silently but auditable via size
    return entry.plan;
  }

  invalidate(sessionId: string): void {
    this.staged.delete(sessionId);
  }

  invalidateModel(modelKey: string): number {
    let n = 0;
    for (const [key, entry] of this.staged) {
      if (entry.modelKey === modelKey) {
        this.staged.delete(key);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.staged.size;
  }
}

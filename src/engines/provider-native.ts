// Provider-native compaction adapter. The core never names providers: the
// deployer injects a probe + request pair for a specific provider mechanism
// (e.g. an encrypted remote checkpoint). Everything the adapter produces is
// opaque to the core; integrity and fallback rules live here.

import type {
  CapabilityResult,
  CompactionEngine,
  CompactionPlan,
  CompactionResult,
  EngineId,
  RuntimeContext,
} from "../core/types.ts";

/** Provider-supplied capability probe. Must fail closed. */
export type NativeProbe = (ctx: RuntimeContext) => CapabilityResult;

export interface NativeRequestInput {
  sessionId: string;
  input: CompactionPlan["input"];
  signal: AbortSignal | undefined;
}

/** Provider-supplied request. Throws on failure/cancellation; never fakes. */
export type NativeRequest = (
  input: NativeRequestInput,
) => Promise<{ summary: string; checkpoint: unknown; usage?: { input: number; output: number } }>;

export interface NativeCompactionOptions {
  engineId?: EngineId;
  probe: NativeProbe;
  request: NativeRequest;
  /** Hard deadline for one native request (bounded retries policy, V13-style). */
  timeoutMs?: number;
}

export function createProviderNativeEngine(options: NativeCompactionOptions): CompactionEngine {
  const id: EngineId = options.engineId ?? "provider-native";
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    id,
    probe(ctx: RuntimeContext): CapabilityResult {
      try {
        return options.probe(ctx);
      } catch (error) {
        return { supported: false, reason: `probe threw: ${(error as Error).message}` };
      }
    },
    plan(ctx: RuntimeContext, input: CompactionPlan["input"]): CompactionPlan {
      return {
        engine: id,
        sessionId: ctx.sessionId,
        summarizeEntryIds: [],
        firstKeptEntryId: ctx.leafId,
        tokensBefore: { value: input.length * 100, source: "estimated" },
        // Native checkpoints replace the whole prefix: not prefix-stable.
        prefixStable: false,
        input,
      };
    },
    async compact(plan: CompactionPlan): Promise<CompactionResult> {
      if (plan.signal?.aborted) {
        return { engine: id, summary: "", details: {}, cancelled: true };
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(plan.signal ? [plan.signal] : []),
      ]);
      try {
        const result = await options.request({
          sessionId: plan.sessionId,
          input: plan.input,
          signal,
        });
        if (plan.signal?.aborted) {
          return { engine: id, summary: "", details: {}, cancelled: true };
        }
        if (typeof result.summary !== "string" || result.summary.length === 0) {
          throw new Error(
            "native request returned no summary; refusing to fake provider-native output",
          );
        }
        return {
          engine: id,
          summary: result.summary,
          details: { nativeCheckpoint: result.checkpoint },
          usage: result.usage,
        };
      } catch (error) {
        if (plan.signal?.aborted) {
          return { engine: id, summary: "", details: {}, cancelled: true };
        }
        throw error;
      }
    },
  };
}

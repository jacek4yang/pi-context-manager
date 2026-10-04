import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./pi-types.ts";
import { join } from "node:path";
import { STACK_INFO } from "./info.ts";
import { classifyItem } from "./core/classify.ts";
import { estimateTextTokens, pressure } from "./core/estimate.ts";
import { DEFAULT_HYGIENE_POLICY, type ContextItem, type HygienePolicy } from "./core/types.ts";
import type { EvidenceRef } from "./core/evidence.ts";
import { EvidenceStore } from "./evidence/store.ts";
import { planHygiene } from "./hygiene/hygiene.ts";
import { createRecallTool } from "./recall/tool.ts";
import { DeterministicEngine } from "./engines/deterministic.ts";
import { CompactionCancelled, EngineSelector, NoEngineError } from "./engines/selector.ts";
import type { CompactionPlan, RuntimeContext } from "./core/types.ts";

/**
 * pi-context-manager — experimental context management and session continuity.
 *
 * feat/provider-native-engine: pluggable compaction engines behind the
 * probe→plan→compact contract. The default chain is deterministic (zero-model);
 * provider-native engines are injected via createProviderNativeEngine and are
 * never faked — an unsupported probe falls back, an all-engine failure cancels
 * compaction with state preserved (C8/C9/C10/C11).
 */
export default function piContextManager(pi: ExtensionAPI) {
  const enabled = process.env.PINX_HYGIENE !== "off";
  const store = new EvidenceStore(join(getAgentDir(), "pinx", "context-manager", "evidence"));
  const refsById = new Map<string, EvidenceRef>();
  let sessionId = "";
  const archivedEntryIds = new Set<string>();
  const selector = new EngineSelector([new DeterministicEngine()]);
  // Policy overrides for demos/tests and explicit operator declarations:
  //   PINX_HYGIENE_RECENT_MS  — recency window (default 30 min)
  //   PINX_HYGIENE_ARCHIVABLE — comma list of EXTRA read-only tool names.
  //     Fail-safe default: unknown tools are never archivable; operators must
  //     declare third-party read-only tools (e.g. fff's "ffgrep") explicitly.
  const extraArchivable = (process.env.PINX_HYGIENE_ARCHIVABLE ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const policy: HygienePolicy = {
    ...DEFAULT_HYGIENE_POLICY,
    recentWindowMs: process.env.PINX_HYGIENE_RECENT_MS
      ? Number(process.env.PINX_HYGIENE_RECENT_MS) || DEFAULT_HYGIENE_POLICY.recentWindowMs
      : DEFAULT_HYGIENE_POLICY.recentWindowMs,
    archivableTools: new Set([...DEFAULT_HYGIENE_POLICY.archivableTools, ...extraArchivable]),
  };

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId() ?? "";
    refsById.clear();
    archivedEntryIds.clear();
    // Rebuild branch-sensitive state from persisted custom entries only —
    // never by scanning raw history of abandoned branches.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STACK_INFO.customTypes.evidence) {
        const ref = (entry.data as { ref?: EvidenceRef } | undefined)?.ref;
        if (ref && ref.v === 1) {
          refsById.set(ref.id, ref);
          archivedEntryIds.add(ref.entryId);
        }
      }
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!enabled || !sessionId) return undefined;
    const plan = await buildPlan(ctx.sessionManager);
    if (plan.entries.length === 0) return undefined;
    for (const entry of plan.entries) {
      refsById.set(entry.ref.id, entry.ref);
      archivedEntryIds.add(entry.targetId);
      pi.appendEntry(STACK_INFO.customTypes.evidence, { ref: entry.ref, toolName: entry.toolName });
      pi.events.emit("pinx.activity", {
        v: 1,
        kind: "context.archived",
        summary: `Archived ${entry.toolName} output · ${entry.chars} chars`,
        detail: { chars: entry.chars, ref: entry.ref.id, entryId: entry.targetId },
        ts: Date.now(),
      });
    }
    emitContextStatus(pi, ctx);
    return {
      entries: plan.entries.map((entry) => ({
        type: "context_edit" as const,
        targetId: entry.targetId,
        replacement: { content: [{ type: "text" as const, text: entry.replacement }] },
      })),
    };
  });

  // Compaction engines (Layer 6). We never fabricate a provider-native
  // summary: unsupported probes fall back down the chain, and an all-engine
  // failure cancels compaction with the previous usable state preserved (C8).
  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled || !sessionId) return undefined;
    const preparation = event.preparation;
    const input = serializeInput(preparation.messagesToSummarize);
    const candidates = preparation.messagesToSummarize.map((message, index) => ({
      entryId: `m${index}`,
      role: message.role,
      toolName:
        message.role === "toolResult" ? (message as { toolName?: string }).toolName : undefined,
      isError:
        message.role === "toolResult" ? (message as { isError?: boolean }).isError : undefined,
      chars: JSON.stringify(message)?.length ?? 0,
    }));
    const runtime: RuntimeContext = {
      sessionId,
      leafId: ctx.sessionManager.getLeafId() ?? "",
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      tokensUsed:
        ctx.getContextUsage()?.tokens != null
          ? { value: ctx.getContextUsage()!.tokens!, source: "provider-reported" }
          : undefined,
      contextWindow: ctx.getContextUsage()?.contextWindow,
      signal: event.signal,
    };
    try {
      const outcome = await selector.run(
        runtime,
        candidates,
        input,
        preparation.firstKeptEntryId,
        event.signal,
      );
      return {
        compaction: {
          summary: outcome.result.summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            engine: outcome.result.engine,
            attempts: outcome.attempts,
            nativeCheckpoint: outcome.result.details.nativeCheckpoint,
          },
        },
      };
    } catch (error) {
      const reason =
        error instanceof CompactionCancelled
          ? "cancelled"
          : error instanceof NoEngineError
            ? "all engines failed"
            : "engine error";
      pi.appendEntry(STACK_INFO.customTypes.summary, {
        kind: "compaction-failed",
        reason,
        detail: (error as Error).message,
      });
      await ctx.ui.notify(
        `context-manager: compaction cancelled (${reason}); previous context preserved`,
        "warning",
      );
      return { cancel: true };
    }
  });

  pi.registerTool(
    createRecallTool({
      store,
      sessionId: () => sessionId,
      branchEntryIds: () => archivedEntryIds,
      refs: () => refsById,
    }) as unknown as Parameters<ExtensionAPI["registerTool"]>[0],
  );

  pi.registerCommand("context-manager", {
    description: "Show context composition; `plan` previews hygiene without writing",
    handler: async (args, ctx) => {
      if (args.trim() === "plan") {
        const plan = await buildPlan(ctx.sessionManager);
        const lines = plan.entries.map((e) => `  ${e.toolName} ${e.chars} chars → ${e.ref.id}`);
        await ctx.ui.notify(
          `hygiene plan (dry run): ${plan.entries.length} edits, ${plan.protectedCount} protected\n${lines.join("\n") || "  nothing eligible"}`,
          "info",
        );
        return;
      }
      const usage = ctx.getContextUsage();
      const projection = ctx.sessionManager.buildSessionProjection();
      const items = projectionItems(projection);
      const dispositions = { protected: 0, eligible: 0, recoverable: 0 };
      for (const item of items) dispositions[classifyItem(item).disposition]++;
      const est = estimateTextTokens(JSON.stringify(projection.messages) ?? "");
      const ratio = pressure(
        usage?.tokens ? { value: usage.tokens, source: "provider-reported" } : est,
        usage?.contextWindow,
      );
      await ctx.ui.notify(
        [
          `pi-context-manager ${STACK_INFO.contractVersion} · recover before summarize, summarize before discard`,
          `messages: ${items.length} · ~${est.value} tokens (estimated)${ratio !== undefined ? ` · pressure ${(ratio * 100).toFixed(0)}%` : ""}`,
          `protected ${dispositions.protected} · eligible ${dispositions.eligible} · archived refs ${refsById.size}`,
        ].join("\n"),
        "info",
      );
    },
  });

  async function buildPlan(sessionManager: ReadonlySessionManager) {
    const items = projectionItems(sessionManager.buildSessionProjection());
    const candidates = items
      .filter((item) => item.role === "toolResult" && item.content)
      .map((item) => ({ item, content: item.content! }));
    return planHygiene(sessionId, candidates, store, policy);
  }

  /** Publish the pinx.context.status contract event (CONTRACTS.md §2). */
  function emitContextStatus(
    pi: ExtensionAPI,
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ): void {
    try {
      const projection = ctx.sessionManager.buildSessionProjection();
      const items = projectionItems(projection);
      let protectedTokens = 0;
      let eligibleTokens = 0;
      for (const item of items) {
        const tokens = estimateTextTokens(JSON.stringify(item.content ?? "") ?? "").value;
        if (classifyItem(item).disposition === "protected") protectedTokens += tokens;
        else eligibleTokens += tokens;
      }
      const usage = ctx.getContextUsage();
      const usedTokens =
        usage?.tokens != null
          ? { value: usage.tokens, source: "provider-reported" as const }
          : { value: protectedTokens + eligibleTokens, source: "estimated" as const };
      pi.events.emit("pinx.context.status", {
        v: 1,
        contextWindow: usage?.contextWindow ?? null,
        usedTokens,
        breakdown: [
          { label: "protected", tokens: protectedTokens, source: "estimated" },
          { label: "reclaimable", tokens: eligibleTokens, source: "estimated" },
        ],
        activeEngine: "deterministic",
        archivedRefs: refsById.size,
      });
    } catch {
      // Status emission is best-effort and must never break a turn boundary.
    }
  }
}

interface ProjectionLike {
  entries: Array<{
    sourceEntry: { id: string };
    messages: Array<{ role: string; toolName?: string; isError?: boolean; timestamp?: number }>;
  }>;
  messages: unknown[];
}

interface ItemWithContent extends ContextItem {
  content?: string;
}

const MAX_INPUT_ITEM_CHARS = 400;

function serializeInput(messages: ReadonlyArray<{ role: string }>): CompactionPlan["input"] {
  return messages.map((message) => {
    const text = messageText(message);
    const bounded =
      text.length > MAX_INPUT_ITEM_CHARS ? text.slice(0, MAX_INPUT_ITEM_CHARS - 1) + "…" : text;
    return {
      role: message.role,
      toolName:
        message.role === "toolResult" ? (message as { toolName?: string }).toolName : undefined,
      isError:
        message.role === "toolResult" ? (message as { isError?: boolean }).isError : undefined,
      text: bounded,
    };
  });
}

/** Extract text from any AgentMessage content shape: string, text blocks, or none. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t.length > 0)
    .join("\n");
}

function projectionItems(projection: ProjectionLike): ItemWithContent[] {
  const items: ItemWithContent[] = [];
  for (const projected of projection.entries) {
    for (const message of projected.messages) {
      const content = messageText(message);
      items.push({
        entryId: projected.sourceEntry.id,
        role: message.role,
        toolName: message.toolName,
        isError: message.isError,
        ts: message.timestamp,
        chars: JSON.stringify(message)?.length ?? 0,
        content,
      });
    }
  }
  return items;
}

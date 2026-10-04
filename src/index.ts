import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReadonlySessionManager } from "./pi-types.ts";
import { join } from "node:path";
import { STACK_INFO } from "./info.ts";
import { classifyItem } from "./core/classify.ts";
import { estimateTextTokens, pressure } from "./core/estimate.ts";
import { DEFAULT_HYGIENE_POLICY, type ContextItem } from "./core/types.ts";
import type { EvidenceRef } from "./core/evidence.ts";
import { EvidenceStore } from "./evidence/store.ts";
import { planHygiene } from "./hygiene/hygiene.ts";
import { createRecallTool } from "./recall/tool.ts";

/**
 * pi-context-manager — experimental context management and session continuity.
 *
 * feat/hygiene-recall: deterministic hygiene plans committed as Pi-native
 * context_edit drafts at turn boundaries, a bounded content-verified evidence
 * store, and the pinx_recall retrieval tool. Canonical history is never
 * deleted: originals stay in session JSONL and in the evidence store (C1/C2).
 */
export default function piContextManager(pi: ExtensionAPI) {
  const enabled = process.env.PINX_HYGIENE !== "off";
  const store = new EvidenceStore(join(getAgentDir(), "pinx", "context-manager", "evidence"));
  const refsById = new Map<string, EvidenceRef>();
  let sessionId = "";
  const archivedEntryIds = new Set<string>();

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
    }
    return {
      entries: plan.entries.map((entry) => ({
        type: "context_edit" as const,
        targetId: entry.targetId,
        replacement: { content: [{ type: "text" as const, text: entry.replacement }] },
      })),
    };
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
    return planHygiene(sessionId, candidates, store, DEFAULT_HYGIENE_POLICY);
  }
}

interface ProjectionLike {
  entries: Array<{
    sourceEntry: { id: string };
    messages: Array<{ role: string; toolName?: string; isError?: boolean }>;
  }>;
  messages: unknown[];
}

interface ItemWithContent extends ContextItem {
  content?: string;
}

function projectionItems(projection: ProjectionLike): ItemWithContent[] {
  const items: ItemWithContent[] = [];
  for (const projected of projection.entries) {
    for (const message of projected.messages) {
      const withContent = message as unknown as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlocks =
        withContent.content?.filter((b) => b.type === "text" && typeof b.text === "string") ?? [];
      const content = textBlocks.map((b) => b.text).join("\n");
      items.push({
        entryId: projected.sourceEntry.id,
        role: message.role,
        toolName: message.toolName,
        isError: message.isError,
        chars: JSON.stringify(message)?.length ?? 0,
        content,
      });
    }
  }
  return items;
}

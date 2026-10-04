import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STACK_INFO } from "./info.ts";
import { classifyItem } from "./core/classify.ts";
import { estimateTextTokens, pressure } from "./core/estimate.ts";
import { DEFAULT_HYGIENE_POLICY, type Classification } from "./core/types.ts";

/**
 * pi-context-manager — experimental context management and session continuity.
 *
 * feat/core-contract: layer types, deterministic classification policy, honest
 * token estimation, and a live observability readout. Hygiene actions,
 * evidence store, checkpoints, and engines land on later branches.
 */
export default function piContextManager(pi: ExtensionAPI) {
  pi.registerCommand("context-manager", {
    description: "Show context composition and hygiene dispositions",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const projection = ctx.sessionManager.buildSessionProjection();
      const classifications: Classification[] = [];
      for (const projected of projection.entries) {
        for (const message of projected.messages) {
          const role = message.role;
          // The AgentMessage union has no common content field; bound by the
          // full serialized message and read toolResult fields via narrowing.
          const toolResult =
            role === "toolResult"
              ? (message as { toolName?: string; isError?: boolean })
              : undefined;
          const chars = JSON.stringify(message)?.length ?? 0;
          classifications.push(
            classifyItem(
              {
                entryId: projected.sourceEntry.id,
                role,
                toolName: toolResult?.toolName,
                isError: toolResult?.isError,
                chars,
              },
              DEFAULT_HYGIENE_POLICY,
            ),
          );
        }
      }

      const byDisposition = new Map<string, number>();
      for (const c of classifications) {
        byDisposition.set(c.disposition, (byDisposition.get(c.disposition) ?? 0) + 1);
      }
      const est = estimateTextTokens(JSON.stringify(projection.messages) ?? "");
      const ratio = pressure(
        usage ? { value: usage.tokens ?? est.value, source: "provider-reported" } : est,
        usage?.contextWindow,
      );

      const lines = [
        `pi-context-manager ${STACK_INFO.contractVersion} · invariant: recover before summarize`,
        `messages: ${classifications.length} · ${est.source} tokens: ~${est.value}${ratio !== undefined ? ` · pressure: ${(ratio * 100).toFixed(0)}%` : ""}`,
        `protected: ${byDisposition.get("protected") ?? 0} · eligible: ${byDisposition.get("eligible") ?? 0}`,
        `(hygiene actions, evidence store, and engines land on later branches)`,
      ];
      await ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

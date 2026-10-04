// Deterministic classification of context items (Layer 2 policy).
// Zero-model: pure decisions over metadata. The invariants this enforces are
// tested in test/classify.test.ts (C5, C6, and the protect-by-default rule).

import type { Classification, ContextItem, HygienePolicy } from "./types.ts";
import { DEFAULT_HYGIENE_POLICY } from "./types.ts";

export function classifyItem(
  item: ContextItem,
  policy: HygienePolicy = DEFAULT_HYGIENE_POLICY,
  now = Date.now(),
): Classification {
  switch (item.role) {
    case "system":
      return {
        category: "system",
        disposition: "protected",
        reason: "prompt and tool declarations",
      };
    case "user":
      return { category: "user", disposition: "protected", reason: "user input" };
    case "assistant":
      return {
        category: item.toolName ? "tool-call" : "assistant-text",
        disposition: "protected",
        reason: "conversation substance",
      };
    case "custom":
      return { category: "memory", disposition: "protected", reason: "extension state" };
    case "summary":
      return {
        category: "summary",
        disposition: "protected",
        reason: "already-summarized content is never re-reduced without policy (C13)",
      };
    default:
      break;
  }

  if (item.role !== "toolResult") {
    return { category: "tool-result", disposition: "protected", reason: "unknown role" };
  }

  if (item.isError) {
    return {
      category: "tool-result",
      disposition: "protected",
      reason: "errors are never discarded (C6)",
    };
  }

  const toolName = item.toolName ?? "unknown";
  if (policy.mutatingTools.has(toolName)) {
    return { category: "tool-result", disposition: "protected", reason: "mutating operation" };
  }
  if (!policy.archivableTools.has(toolName)) {
    // Unknown / unclassified tool output is treated as unsafe (protect).
    return {
      category: "tool-result",
      disposition: "protected",
      reason: "unknown tool output is unsafe to archive",
    };
  }

  const age = item.ts !== undefined ? now - item.ts : Number.POSITIVE_INFINITY;
  if (item.ts === undefined || age < policy.recentWindowMs) {
    return {
      category: "tool-result",
      disposition: "protected",
      reason: "recent work stays protected (C5)",
    };
  }

  return {
    category: "tool-result",
    disposition: "eligible",
    reason: `old successful ${toolName} output`,
  };
}

/** True when every candidate passed classification as eligible. */
export function allEligible(
  items: ContextItem[],
  policy: HygienePolicy = DEFAULT_HYGIENE_POLICY,
  now = Date.now(),
): boolean {
  return items.every((item) => classifyItem(item, policy, now).disposition === "eligible");
}

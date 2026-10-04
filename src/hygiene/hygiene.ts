// Deterministic context hygiene (Layer 2): plan-only here, commit via
// Pi-native context_edit drafts at turn boundaries.
//
// Pipeline: classify → threshold → archive to evidence store → produce
// bounded marker replacement + a context_edit draft. Canonical history is
// never deleted (C1): replacement is an append-only edit, and the evidence
// stays retrievable (C2). Failure at ANY point aborts the whole batch with
// originals untouched (C7).

import { classifyItem } from "../core/classify.ts";
import { formatMarker } from "../core/evidence.ts";
import type { EvidenceRef } from "../core/evidence.ts";
import {
  DEFAULT_HYGIENE_POLICY,
  type Classification,
  type ContextItem,
  type HygienePolicy,
} from "../core/types.ts";
import type { EvidenceStore } from "../evidence/store.ts";

export interface HygieneCandidate {
  item: ContextItem;
  /** Full original content of the tool result. */
  content: string;
}

export interface HygienePlanEntry {
  /** Session entry the context_edit targets. */
  targetId: string;
  toolName: string;
  chars: number;
  ref: EvidenceRef;
  /** Replacement content: bounded marker + short head preview. */
  replacement: string;
}

export interface HygienePlan {
  sessionId: string;
  entries: HygienePlanEntry[];
  /** Entries classified protected and therefore never touched. */
  protectedCount: number;
  skipped: Array<{ entryId: string; reason: string }>;
}

export interface HygieneThresholds {
  /** Only archive results larger than this many chars. */
  minChars: number;
  /** Maximum number of edits per turn (bounded, cache-friendly batches). */
  maxEditsPerTurn: number;
}

export const DEFAULT_THRESHOLDS: HygieneThresholds = {
  minChars: 4_000,
  maxEditsPerTurn: 8,
};

function evidenceKind(
  toolName: string | undefined,
): "bash" | "read" | "grep" | "find" | "ls" | "generic" {
  switch (toolName) {
    case "bash":
    case "read":
    case "grep":
    case "find":
    case "ls":
      return toolName;
    default:
      return "generic";
  }
}

export function planHygiene(
  sessionId: string,
  candidates: HygieneCandidate[],
  store: EvidenceStore,
  policy: HygienePolicy = DEFAULT_HYGIENE_POLICY,
  thresholds: HygieneThresholds = DEFAULT_THRESHOLDS,
  now = Date.now(),
): Promise<HygienePlan> {
  return planHygieneWithClassifier(
    sessionId,
    candidates,
    store,
    (item) => classifyItem(item, policy, now),
    thresholds,
  );
}

export async function planHygieneWithClassifier(
  sessionId: string,
  candidates: HygieneCandidate[],
  store: EvidenceStore,
  classify: (item: ContextItem) => Classification,
  thresholds: HygieneThresholds = DEFAULT_THRESHOLDS,
): Promise<HygienePlan> {
  const plan: HygienePlan = { sessionId, entries: [], protectedCount: 0, skipped: [] };
  for (const candidate of candidates) {
    const classification = classify(candidate.item);
    if (classification.disposition !== "eligible") {
      if (classification.disposition === "protected") plan.protectedCount++;
      plan.skipped.push({ entryId: candidate.item.entryId, reason: classification.reason });
      continue;
    }
    if (candidate.content.length < thresholds.minChars) {
      plan.skipped.push({
        entryId: candidate.item.entryId,
        reason: `below threshold (${candidate.content.length} chars)`,
      });
      continue;
    }
    if (plan.entries.length >= thresholds.maxEditsPerTurn) {
      plan.skipped.push({
        entryId: candidate.item.entryId,
        reason: "per-turn edit budget reached",
      });
      continue;
    }
    // Archive BEFORE producing the replacement: evidence must be durably
    // retrievable before context loses the original (recover before summarize).
    const kind = evidenceKind(candidate.item.toolName);
    const ref = await store.put({
      sessionId,
      entryId: candidate.item.entryId,
      kind,
      content: candidate.content,
    });
    plan.entries.push({
      targetId: candidate.item.entryId,
      toolName: candidate.item.toolName ?? "generic",
      chars: candidate.content.length,
      ref,
      replacement: formatMarker({
        kind,
        chars: candidate.content.length,
        ref: ref.id,
        head: candidate.content.split("\n", 2).join("\n").slice(0, 200),
      }),
    });
  }
  return plan;
}

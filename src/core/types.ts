// Core contract types for the context manager stack (CONTEXT-MODEL.md).
// Pure data shapes shared across layers; no Pi imports here.

import type { EvidenceRef } from "./evidence.ts";

/** Message categories for the observability model (Layer 1). */
export type ContextCategory =
  | "system"
  | "user"
  | "assistant-text"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "summary"
  | "memory";

/** Hygiene disposition of one context item (Layer 2 policy). */
export type Disposition = "protected" | "eligible" | "recoverable";

/**
 * Active-working-set category (cacheability groundwork, CONTEXT-MODEL.md §cache).
 * Annotation only in this phase: derived deterministically from the same
 * metadata that decides the disposition — no model, no behavior change.
 * Future task-aware policies consume it; today it feeds observability and
 * the benchmark's classification audit.
 */
export type WorkingSet =
  | "must-keep" // conversation substance, errors, mutations, unknown-unsafe output
  | "active" // recent successful read-only output inside the recency window
  | "recent" // reserved: older items recently re-touched (not derivable yet)
  | "archivable" // old successful read-only output — the primary archive candidate
  | "summarizable" // reserved: future summarization candidates
  | "cold-evidence"; // reserved: already archived, retrievable only via recall

export interface ContextItem {
  /** Stable id matching the session entry that owns this message. */
  entryId: string;
  role: string;
  toolName?: string;
  isError?: boolean;
  /** Bounded char count of the message content (never presented as tokens). */
  chars: number;
  ts?: number;
}

export interface Classification {
  category: ContextCategory;
  disposition: Disposition;
  /** Why this disposition was chosen — surfaced in observability UI. */
  reason: string;
  /** Deterministic active-working-set category (annotation; see WorkingSet). */
  workingSet: WorkingSet;
}

export interface HygienePolicy {
  /** Entries newer than this (ms) are always protected (C5). */
  recentWindowMs: number;
  /** Tools whose results may be archived when old and successful. */
  archivableTools: ReadonlySet<string>;
  /** Tools whose output mutates state; never archivable. */
  mutatingTools: ReadonlySet<string>;
}

export const DEFAULT_HYGIENE_POLICY: HygienePolicy = {
  recentWindowMs: 30 * 60 * 1000,
  archivableTools: new Set(["read", "grep", "find", "ls"]),
  mutatingTools: new Set(["write", "edit", "bash", "code", "python", "node"]),
};

/** Structured summary produced for one completed work batch (Layer 4). */
export interface BatchSummary {
  purpose: string;
  findings: string[];
  decisions: Array<{ decision: string; rationale?: string }>;
  changedFiles: Array<{ path: string; state: "read" | "modified" | "created" }>;
  tests: Array<{ name: string; status: "pass" | "fail"; note?: string }>;
  failures: Array<{ subject: string; error: string }>;
  unresolved: string[];
  evidenceRefs: EvidenceRef[];
}

/** Live task state, distinct from long-term memory (Layer 5). */
export interface ContinuityCheckpoint {
  checkpointId: string;
  atEntryId: string;
  goal: string[];
  constraints: string[];
  decisions: Array<{ decision: string; rationale?: string }>;
  completed: string[];
  pending: string[];
  blockers: string[];
  files: Array<{ path: string; state: "read" | "modified" | "created" }>;
  tests: Array<{ name: string; status: "pass" | "fail"; note?: string }>;
  evidenceRefs: EvidenceRef[];
}

export interface RuntimeContext {
  /** session id owning the context (provenance scope). */
  sessionId: string;
  /** Current abort signal, when compaction runs inside a live turn. */
  signal?: AbortSignal;
  /** Current leaf entry id. */
  leafId: string;
  model: { provider: string; modelId: string } | undefined;
  tokensUsed: { value: number; source: "provider-reported" | "estimated" } | undefined;
  contextWindow: number | undefined;
}

export type EngineId = "deterministic" | "generic-verified" | "provider-native" | "hybrid";

export interface CapabilityResult {
  supported: boolean;
  /** Why the probe decided this; required when supported is false. */
  reason?: string;
}

export interface CompactionPlan {
  engine: EngineId;
  sessionId: string;
  /** Entries the plan would summarize (never across compaction boundaries). */
  summarizeEntryIds: string[];
  firstKeptEntryId: string;
  tokensBefore: { value: number; source: "provider-reported" | "estimated" };
  /** Prefix-stability annotation (PROVIDER-MODEL.md cache discipline). */
  prefixStable: boolean;
  /** Bounded serialized content of the summarized span. */
  input: Array<{ role: string; toolName?: string; isError?: boolean; text: string }>;
  /** Cancellation for the whole plan/compact lifecycle (C9). */
  signal?: AbortSignal;
}

export interface CompactionResult {
  engine: EngineId;
  summary: string;
  /** Structured facts the summary was built from / verified against. */
  details: {
    changedFiles?: string[];
    readFiles?: string[];
    batchSummaries?: BatchSummary[];
    /** Opaque provider-native checkpoint; integrity is the adapter's duty. */
    nativeCheckpoint?: unknown;
  };
  usage?: { input: number; output: number };
  cancelled?: boolean;
}

/** Engine contract (Layer 6). Probe → plan → compact; every stage bounded. */
export interface CompactionEngine {
  readonly id: EngineId;
  probe(ctx: RuntimeContext): CapabilityResult;
  plan(ctx: RuntimeContext, input: CompactionPlan["input"]): CompactionPlan;
  compact(plan: CompactionPlan): Promise<CompactionResult>;
}

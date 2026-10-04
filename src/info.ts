// Stack metadata. Pure data, no Pi imports.
export const STACK_INFO = {
  name: "pi-context-manager",
  pinxNamespace: "pinx",
  contractVersion: 1,
  /** customType namespace for custom entries/messages (never reuse stable-stack ids). */
  customTypes: {
    checkpoint: "pinx.context.checkpoint",
    summary: "pinx.context.summary",
    evidence: "pinx.context.evidence",
  },
  stateRoot: "pinx/context-manager",
} as const;

/**
 * Fundamental invariant (docs/INVARIANTS.md):
 *   Recover before summarize. Summarize before discard.
 * No destructive context reduction unless the removed evidence remains
 * recoverable from canonical session history or a verified retrievable artifact.
 */
export const CORE_INVARIANT = "Recover before summarize. Summarize before discard.";

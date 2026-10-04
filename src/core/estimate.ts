// Token estimation with honest labeling. Byte/char counts are never presented
// as tokens (INVARIANTS.md Layer 1 rule); every estimate carries its source.

export type TokenSource = "provider-reported" | "estimated";

export interface TokenFigure {
  value: number;
  source: TokenSource;
}

/** Conservative char-based estimate (~4 chars/token, rounded up). */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function estimateTextTokens(text: string): TokenFigure {
  return { value: estimateTokens(text.length), source: "estimated" };
}

/** Wrap a provider-reported figure so it can never be confused with an estimate. */
export function providerTokens(value: number): TokenFigure {
  return { value, source: "provider-reported" };
}

/** Context pressure as a bounded ratio; undefined when the window is unknown. */
export function pressure(
  used: TokenFigure | undefined,
  window: number | undefined,
): number | undefined {
  if (!used || window === undefined || window <= 0) return undefined;
  return Math.min(1, Math.max(0, used.value / window));
}

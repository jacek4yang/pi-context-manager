// Byte-accurate prompt-prefix cacheability analysis (CONTEXT-MODEL.md §cache).
//
// Compares two serialized model-context projections and reports how much of
// the earlier one survives byte-identical into the later one. This is the
// "stable prefix" metric: a LOCAL property of the projections themselves.
//
// Terminology discipline (docs/benchmark/README.md in the meta repository):
//   - prompt-prefix cacheability : the property being measured here
//   - stable prefix              : the byte-identical head shared by two projections
//   - local resource cache hit   : evidence/recall retrieving locally stored bytes
//   - provider-reported cache hit: only ever comes from the provider; never inferred
//
// The comparison is UTF-8 byte-accurate. A change inside a multi-byte
// character splits at the differing BYTE, not the character boundary — the
// offset is a byte offset by contract.

export interface ProjectionComparison {
  /** Serialized size of the earlier projection, in bytes. */
  bytesA: number;
  /** Serialized size of the later projection, in bytes. */
  bytesB: number;
  /** Length of the byte-identical head shared by A and B. */
  commonPrefixBytes: number;
  /**
   * commonPrefixBytes / min(bytesA, bytesB), in [0, 1].
   * 1 when both projections are empty (vacuously identical); 0 when exactly
   * one side is empty (no byte can be shared).
   */
  commonPrefixRatio: number;
  /**
   * 0-based byte offset of the first differing byte.
   * Equal to min(bytesA, bytesB) when one is a prefix of the other,
   * and to bytesA when the projections are identical.
   */
  firstChangedByte: number;
  /** Bytes in B from the first change onward (the regenerated suffix). */
  changedSuffixBytesB: number;
}

export function compareProjections(
  a: string | Uint8Array,
  b: string | Uint8Array,
): ProjectionComparison {
  const bufA = typeof a === "string" ? Buffer.from(a, "utf8") : Buffer.from(a);
  const bufB = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  const min = Math.min(bufA.length, bufB.length);
  let i = 0;
  while (i < min && bufA[i] === bufB[i]) i++;
  return {
    bytesA: bufA.length,
    bytesB: bufB.length,
    commonPrefixBytes: i,
    commonPrefixRatio: min === 0 ? (bufA.length === 0 && bufB.length === 0 ? 1 : 0) : i / min,
    firstChangedByte: i,
    changedSuffixBytesB: bufB.length - i,
  };
}

/** Serialized projection comparison over a turn sequence: consecutive pairs. */
export interface PrefixSeries {
  /** comparisons[i] compares turn i with turn i+1. */
  comparisons: ProjectionComparison[];
  /** commonPrefixRatio averaged over the consecutive pairs. */
  averageStablePrefixRatio: number;
  /** commonPrefixBytes of the final consecutive pair. */
  finalCommonPrefixBytes: number;
}

export function compareProjectionSeries(serialized: Array<string | Uint8Array>): PrefixSeries {
  if (serialized.length < 2) {
    throw new Error("prefix series needs at least two serialized projections");
  }
  const comparisons: ProjectionComparison[] = [];
  for (let i = 0; i < serialized.length - 1; i++) {
    comparisons.push(compareProjections(serialized[i]!, serialized[i + 1]!));
  }
  const averageStablePrefixRatio =
    comparisons.reduce((sum, c) => sum + c.commonPrefixRatio, 0) / comparisons.length;
  const last = comparisons[comparisons.length - 1]!;
  return {
    comparisons,
    averageStablePrefixRatio,
    finalCommonPrefixBytes: last.commonPrefixBytes,
  };
}

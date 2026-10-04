// Evidence references (Layer 3). Shapes only; the store implementation lives
// in the evidence module and enforces the fail-closed properties:
// bounded, branch-aware, session-aware, content-verified.

/** Evidence reference — CONTRACTS.md section 3 shape. */
export interface EvidenceRef {
  v: 1;
  id: string;
  sessionId: string;
  entryId: string;
  sha256: string;
  bytes: number;
  mime?: "text/plain" | "text/x-diff" | "application/json";
  preview?: string;
  createdAt: string;
}

/** Inline marker embedded in replacement content when evidence is archived. */
export interface EvidenceMarker {
  kind: "bash" | "read" | "grep" | "find" | "ls" | "generic";
  chars: number;
  ref: string;
  head?: string;
}

export const MAX_EVIDENCE_PREVIEW = 240;
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export function formatMarker(marker: EvidenceMarker): string {
  const head = marker.head ? `\n${marker.head}` : "";
  return `[Archived ${marker.kind} output · ${marker.chars} chars · ref ${marker.ref}]${head}`;
}

export function parseMarker(line: string): EvidenceMarker | undefined {
  const match = /\[Archived ([a-z-]+) output · ([\d,]+) chars · ref ([A-Za-z0-9_]+)\]/.exec(line);
  if (!match) return undefined;
  return {
    kind: match[1] as EvidenceMarker["kind"],
    chars: Number(match[2]?.replace(/,/g, "")),
    ref: match[3]!,
  };
}

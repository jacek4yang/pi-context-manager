// Evidence store (Layer 3): bounded, session-aware, content-verified.
//
// Fail-closed properties (INVARIANTS C2/C3/C4/C14/C15):
//   - refs are store ids, never filesystem paths (no traversal);
//   - reads re-verify sha256 against the ref AND the sidecar record;
//   - a ref is only retrievable with matching sessionId + entryId provenance;
//   - writes are atomic and bounded; oversize content is refused.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EvidenceRef } from "../core/evidence.ts";
import { MAX_EVIDENCE_BYTES, MAX_EVIDENCE_PREVIEW } from "../core/evidence.ts";

export interface PutInput {
  sessionId: string;
  entryId: string;
  kind: "bash" | "read" | "grep" | "find" | "ls" | "generic";
  content: string;
  mime?: EvidenceRef["mime"];
}

interface Sidecar {
  v: 1;
  entryId: string;
  kind: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class EvidenceStore {
  private root: string;
  private maxBytes: number;
  /** Ref id generator. Random by default; injectable ONLY so benchmarks and
   * determinism tests can fix identity — production always uses randomUUID. */
  private newId: () => string;

  constructor(
    rootDir: string,
    opts?: { maxBytes?: number; idFactory?: () => string },
  ) {
    this.root = resolve(rootDir);
    this.maxBytes = opts?.maxBytes ?? MAX_EVIDENCE_BYTES;
    this.newId = opts?.idFactory ?? (() => `ev_${randomUUID().replace(/-/g, "")}`);
  }

  async put(input: PutInput): Promise<EvidenceRef> {
    if (!SESSION_ID_RE.test(input.sessionId)) {
      throw new EvidenceError("invalid session id for evidence store");
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > this.maxBytes) {
      throw new EvidenceError(`evidence exceeds quota (${bytes} > ${this.maxBytes} bytes)`);
    }
    const id = this.newId();
    const dir = join(this.root, input.sessionId);
    const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
    const ref: EvidenceRef = {
      v: 1,
      id,
      sessionId: input.sessionId,
      entryId: input.entryId,
      sha256,
      bytes,
      mime: input.mime ?? "text/plain",
      preview: head(input.content),
      createdAt: new Date().toISOString(),
    };
    const sidecar: Sidecar = {
      v: 1,
      entryId: input.entryId,
      kind: input.kind,
      sha256,
      bytes,
      createdAt: ref.createdAt,
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Atomic: write temp, then rename onto the final names.
    const tmpContent = join(dir, `.${id}.tmp`);
    const tmpSidecar = join(dir, `.${id}.meta.tmp`);
    await writeFile(tmpContent, input.content, { encoding: "utf8", mode: 0o600 });
    await writeFile(tmpSidecar, JSON.stringify(sidecar), { encoding: "utf8", mode: 0o600 });
    await rename(tmpContent, join(dir, `${id}.bin`));
    await rename(tmpSidecar, join(dir, `${id}.json`));
    return ref;
  }

  /**
   * Retrieve evidence. Fails closed unless every provenance check passes:
   * ref sessionId/entryId must match the caller's claim, the sidecar must
   * agree with the ref, and the content hash must verify.
   */
  async get(
    ref: EvidenceRef,
    opts: { sessionId: string; entryId?: string; offset?: number; limit?: number },
  ): Promise<string> {
    assertValidRef(ref);
    if (ref.sessionId !== opts.sessionId) {
      throw new EvidenceError("evidence belongs to a different session");
    }
    if (opts.entryId !== undefined && ref.entryId !== opts.entryId) {
      throw new EvidenceError("evidence entryId does not match the requested provenance");
    }
    const dir = join(this.root, ref.sessionId);
    const contentPath = join(dir, `${ref.id}.bin`);
    const sidecarPath = join(dir, `${ref.id}.json`);
    let sidecar: Sidecar;
    try {
      sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Sidecar;
    } catch {
      throw new EvidenceError("evidence sidecar missing or corrupt");
    }
    if (
      sidecar.sha256 !== ref.sha256 ||
      sidecar.bytes !== ref.bytes ||
      sidecar.entryId !== ref.entryId
    ) {
      throw new EvidenceError("evidence sidecar does not match ref (possible corruption)");
    }
    let content: string;
    try {
      content = await readFile(contentPath, { encoding: "utf8" });
    } catch {
      throw new EvidenceError("evidence content missing");
    }
    const actual = createHash("sha256").update(content, "utf8").digest("hex");
    if (actual !== ref.sha256) {
      throw new EvidenceError("evidence content hash mismatch (corruption detected)");
    }
    const bytes = Buffer.from(content, "utf8");
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(opts.limit ?? bytes.length, this.maxBytes);
    return bytes.subarray(offset, offset + limit).toString("utf8");
  }

  /** Remove one session's evidence (session deletion / GC support). */
  async dropSession(sessionId: string): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new EvidenceError("invalid session id for evidence store");
    }
    await rm(join(this.root, sessionId), { recursive: true, force: true });
  }
}

export class EvidenceError extends Error {}

function head(content: string): string {
  const oneLine = content.split("\n", 1)[0] ?? "";
  return oneLine.length > MAX_EVIDENCE_PREVIEW
    ? oneLine.slice(0, MAX_EVIDENCE_PREVIEW - 1) + "…"
    : oneLine;
}

function assertValidRef(ref: EvidenceRef): void {
  if (ref.v !== 1 || typeof ref.id !== "string" || !/^ev_[0-9a-f]{32}$/.test(ref.id)) {
    throw new EvidenceError("invalid evidence ref id");
  }
  if (typeof ref.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256)) {
    throw new EvidenceError("invalid evidence ref hash");
  }
  if (
    !SESSION_ID_RE.test(ref.sessionId) ||
    typeof ref.entryId !== "string" ||
    ref.entryId.length === 0
  ) {
    throw new EvidenceError("invalid evidence ref provenance");
  }
}

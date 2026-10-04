// Live engine verification: open an existing session through the real Pi
// runtime (with the user's installed stack) and run session.compact() so the
// session_before_compact engine chain executes for real. Pi owns auth; no
// credentials are read; the deterministic engine makes no model calls.
//
// Usage: node scripts/live-engine-test.mjs <session.jsonl> <cwd>
import assert from "node:assert/strict";
import { resolve } from "node:path";

const sessionPath = resolve(process.argv[2] ?? "");
const cwd = resolve(process.argv[3] ?? process.cwd());
assert.ok(sessionPath, "usage: live-engine-test.mjs <session.jsonl> [cwd]");

const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");

const manager = SessionManager.open(sessionPath, undefined, cwd);
const { session } = await createAgentSession({ sessionManager: manager });
await session.bindExtensions({ mode: "json" });
await session.waitForIdle();

const result = await session.compact("pinx live engine verification");
console.log("compact() engine summary head:", JSON.stringify(result.summary.split("\n")[0]));
session.dispose();
console.log("LIVE-ENGINE-TEST OK");

// Deterministic session fixtures for the Agent efficiency benchmark.
//
// Every value that reaches the model-visible projection is fixed: message
// timestamps, tool-call ids, usage figures, content. Only the evidence ref
// ids are injected through the store's idFactory (identity, not semantics).
// This is what makes the benchmark CI-reproducible and byte-comparable
// across runs and machines.

/** Fixed epoch so fixture timestamps never drift with the wall clock. */
export const T0 = 1_700_000_000_000;

export const SESSION_ID = "bench-session-0001";

/** Structurally complete usage figure; shape mirrors pi-ai Usage. */
export const USAGE = {
  input: 1000,
  output: 100,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 1100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = T0;
/** Reset the fixture clock (each scenario starts from a clean timeline). */
export function resetClock(): void {
  clock = T0;
}
export function tick(): number {
  return clock++;
}

export interface FixtureTurn {
  user: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolOutput: string;
  closing: string;
}

/** One realistic coding turn: prompt → read tool call → output → closing text. */
export function turnMessages(turn: FixtureTurn, callId: string): unknown[] {
  const ts = tick;
  return [
    { role: "user", content: turn.user, timestamp: ts() },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: callId, name: turn.toolName, arguments: turn.toolArgs },
      ],
      api: "openai-completions",
      provider: "bench",
      model: "bench-deterministic",
      usage: USAGE,
      stopReason: "toolUse",
      timestamp: ts(),
    },
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: turn.toolName,
      content: [{ type: "text", text: turn.toolOutput }],
      isError: false,
      timestamp: ts(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: turn.closing }],
      api: "openai-completions",
      provider: "bench",
      model: "bench-deterministic",
      usage: USAGE,
      stopReason: "stop",
      timestamp: ts(),
    },
  ];
}

export const SYSTEM_PROMPT =
  "You are a coding agent working in a deterministic benchmark repository. " +
  "Follow the project conventions; prefer bounded, reviewable edits.";

/** Deterministic pseudo-file content: line-numbered, stable, size-bounded. */
export function syntheticFile(lines: number, seed: string): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`${String(i + 1).padStart(4, "0")}  export function bench_${seed}_${i}(x: number) {`);
    out.push(`${String(i + 1).padStart(4, "0")}    return x * ${i + 1}; // deterministic body`);
    out.push(`${String(i + 1).padStart(4, "0")}  }`);
  }
  return out.join("\n");
}

/** Large read-only output for the archive scenario (deterministic). */
export function syntheticGrepOutput(chars: number): string {
  const lines: string[] = [];
  let size = 0;
  let i = 0;
  while (size < chars) {
    const line = `src/module-${i % 64}.ts:${(i % 400) + 1}: export const MATCH_${i} = "deterministic-grep-hit-${i}";`;
    lines.push(line);
    size += line.length + 1;
    i++;
  }
  return lines.join("\n");
}

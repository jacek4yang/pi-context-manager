// Deterministic engine: zero-model compaction summary. It does not pretend
// to understand the work — it produces an honest, bounded, structured record
// of what is being replaced and where the evidence lives.

import type {
  CompactionEngine,
  CompactionPlan,
  CompactionResult,
  CapabilityResult,
  RuntimeContext,
} from "../core/types.ts";

const MAX_HEAD_LINES = 40;

export class DeterministicEngine implements CompactionEngine {
  readonly id = "deterministic" as const;

  probe(_ctx: RuntimeContext): CapabilityResult {
    // Zero-model: works whenever there is anything to summarize.
    return { supported: true };
  }

  plan(ctx: RuntimeContext, input: CompactionPlan["input"]): CompactionPlan {
    return {
      engine: this.id,
      sessionId: ctx.sessionId,
      summarizeEntryIds: [],
      firstKeptEntryId: ctx.leafId,
      tokensBefore: { value: input.length * 100, source: "estimated" },
      prefixStable: true,
      input,
    };
  }

  async compact(plan: CompactionPlan): Promise<CompactionResult> {
    if (plan.signal?.aborted) {
      return { engine: this.id, summary: "", details: {}, cancelled: true };
    }
    const byTool = new Map<string, number>();
    const errors: string[] = [];
    for (const item of plan.input) {
      if (item.toolName) byTool.set(item.toolName, (byTool.get(item.toolName) ?? 0) + 1);
      if (item.isError) errors.push((item.toolName ?? item.role) + ": " + item.text.slice(0, 120));
    }
    const lines: string[] = [
      `## Deterministic compaction record`,
      `${plan.input.length} messages replaced. Originals remain in canonical session history; large tool outputs remain retrievable through archived evidence refs.`,
      ``,
      `## Tool evidence`,
      ...(byTool.size === 0
        ? ["- (none)"]
        : [...byTool.entries()].map(([tool, n]) => `- ${tool} ×${n}`)),
    ];
    if (errors.length > 0) {
      lines.push(
        ``,
        `## Errors present (never silently discarded, C6)`,
        ...errors.slice(0, 10).map((e) => `- ${e}`),
      );
    }
    lines.push(
      ``,
      `## Head of replaced span`,
      ...plan.input
        .slice(0, MAX_HEAD_LINES)
        .map((i) => `[${i.role}${i.toolName ? "/" + i.toolName : ""}] ${i.text.slice(0, 160)}`),
    );
    return {
      engine: this.id,
      summary: lines.join("\n"),
      details: {},
    };
  }
}

// Mock registration adapter for the context-manager extension: captures
// registered handlers so tests drive the REAL callbacks. Exposes observable
// state (appended entries, bus log) — never the extension's private fields.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MockModel {
  provider: string;
  id: string;
}

export interface MockCtx {
  sessionManager: {
    getSessionId: () => string | undefined;
    getLeafId: () => string | undefined;
    getBranch: () => Array<{ type: string; id: string; customType?: string; data?: unknown }>;
    buildSessionProjection: () => {
      entries: Array<{
        sourceEntry: { id: string };
        messages: Array<{
          role: string;
          toolName?: string;
          isError?: boolean;
          timestamp?: number;
          content?: Array<{ type: string; text?: string }>;
        }>;
      }>;
      messages: Array<unknown>;
    };
  };
  model: MockModel | undefined;
  thinkingLevel: string | undefined;
  getContextUsage: () => { tokens: number; contextWindow: number; percent: number } | undefined;
  ui: { notify: (message: string, kind?: string) => Promise<void> };
}

type Handler = (event: unknown, ctx: MockCtx) => unknown;

export function createMockPiCm(sessionId?: string) {
  const agentDir = mkdtempSync(join(tmpdir(), "pinx-cm-harness-"));
  const sid = sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
  void sessionId;
  const handlers = new Map<string, Handler[]>();
  const busLog: Array<{ channel: string; payload: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  let tools: string[] = ["read", "grep"];
  let sessionFixture: Array<{ type: string; id: string; customType?: string; data?: unknown }> = [];
  let projectionFixture: {
    entries: Array<{
      sourceEntry: { id: string };
      messages: Array<{
        role: string;
        toolName?: string;
        isError?: boolean;
        timestamp?: number;
        content?: Array<{ type: string; text?: string }>;
      }>;
    }>;
    messages: Array<unknown>;
  } = { entries: [], messages: [] };
  let modelOverride: MockModel | undefined;
  const registeredTools: string[] = [];
  const activeToolCalls: string[][] = [];

  const makeCtx = (over: Partial<MockCtx> = {}): MockCtx => ({
    sessionManager: {
      getSessionId: () => sid,
      getLeafId: () => "leaf-x",
      getBranch: () => sessionFixture,
      buildSessionProjection: () => projectionFixture,
    },
    model: modelOverride ? { ...modelOverride } : { provider: "intern", id: "glm-5.3" },
    thinkingLevel: undefined,
    getContextUsage: () => undefined,
    ui: {
      notify: async (message: string) => {
        notifications.push(message);
      },
    },
    ...over,
  });

  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool: (tool: { name?: string }) => {
      registeredTools.push(tool?.name ?? "<unnamed>");
    },
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) => {
      appendedEntries.push({ customType, data });
    },
    sendMessage: () => {},
    getSettings: () => ({}),
    getActiveTools: () => tools,
    setActiveTools: (names: string[]) => {
      activeToolCalls.push([...names]);
      tools = [...names];
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        busLog.push({ channel, payload });
      },
      on: () => () => {},
    },
    __test: {
      dispatch: async (event: string, payload: unknown, ctxOver: Partial<MockCtx> = {}) => {
        const results: unknown[] = [];
        for (const h of handlers.get(event) ?? []) {
          results.push(await h(payload, makeCtx(ctxOver)));
        }
        return results;
      },
    },
  };

  return {
    pi,
    agentDir,
    sessionId: sid,
    busLog,
    appendedEntries,
    notifications,
    registeredTools,
    activeToolCalls,
    cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
    setTools: (names: string[]) => {
      tools = names;
    },
    setSessionFixture: (fixture: typeof sessionFixture) => {
      sessionFixture = fixture;
    },
    setProjectionFixture: (fixture: typeof projectionFixture) => {
      projectionFixture = fixture;
    },
    setModelOverride: (m: MockModel | undefined) => {
      modelOverride = m;
    },
    dispatch: pi.__test.dispatch,
  };
}

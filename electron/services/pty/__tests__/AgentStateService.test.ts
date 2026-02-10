import { afterEach, describe, expect, it } from "vitest";
import { AgentStateService } from "../AgentStateService.js";
import { events } from "../../events.js";
import type { TerminalInfo } from "../types.js";

function createTerminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term-1",
    cwd: "/repo",
    shell: "/bin/zsh",
    spawnedAt: Date.now(),
    analysisEnabled: false,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    restartCount: 0,
    agentId: "claude",
    agentState: "idle",
    ptyProcess: {} as never,
    pendingSemanticData: "",
    semanticFlushTimer: null,
    inputWriteQueue: [],
    inputWriteTimeout: null,
    outputBuffer: "",
    semanticBuffer: [],
    ...overrides,
  } as TerminalInfo;
}

describe("AgentStateService", () => {
  afterEach(() => {
    events.removeAllListeners();
  });

  it("clamps confidence into valid schema range before emitting state-changed", () => {
    const service = new AgentStateService();
    const terminal = createTerminal();
    const stateChanges: Array<{ confidence: number }> = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push({ confidence: payload.confidence });
    });

    const changed = service.transitionState(
      terminal,
      { type: "busy" },
      "heuristic",
      2.5,
      terminal.spawnedAt
    );

    expect(changed).toBe(true);
    expect(terminal.agentState).toBe("working");
    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]?.confidence).toBe(1);
  });

  it("rejects stale transitions with mismatched spawnedAt token", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ spawnedAt: 1000 });
    const stateChanges: unknown[] = [];

    events.on("agent:state-changed", (payload) => {
      stateChanges.push(payload);
    });

    const changed = service.transitionState(terminal, { type: "busy" }, "output", 1.0, 999);

    expect(changed).toBe(false);
    expect(stateChanges).toHaveLength(0);
    expect(terminal.agentState).toBe("idle");
  });

  it("emits completed event with non-negative duration", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ spawnedAt: Date.now() + 10_000, agentState: "working" });
    const completedPayloads: Array<{ duration: number; exitCode: number }> = [];

    events.on("agent:completed", (payload) => {
      completedPayloads.push({ duration: payload.duration, exitCode: payload.exitCode });
    });

    service.emitAgentCompleted(terminal, 0);

    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0]?.duration).toBe(0);
    expect(completedPayloads[0]?.exitCode).toBe(0);
  });
});

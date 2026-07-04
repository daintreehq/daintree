import { describe, expect, it, vi } from "vitest";
import { PtyManager } from "../PtyManager.js";
import { ANALYSIS_SESSION_IDLE_TRIM_MS } from "../../../shared/utils/workerGovernancePolicy.js";
import { SCROLLBACK_MIN } from "../../../shared/config/scrollback.js";
import type { AgentState } from "../../../shared/types/agent.js";
import type { TerminalProcess } from "../pty/TerminalProcess.js";
import type { TerminalRegistry } from "../pty/TerminalRegistry.js";

const NOW = 1_000_000_000;

interface FakeTerminal {
  id: string;
  trimScrollback: ReturnType<typeof vi.fn>;
  getCurrentScrollback: () => number;
  getInfo: () => { agentState?: AgentState; lastInputTime: number; lastOutputTime: number };
}

function makeTerminal(
  id: string,
  opts: {
    agentState?: AgentState;
    idleMs?: number;
    scrollback?: number;
  } = {}
): FakeTerminal {
  const at = NOW - (opts.idleMs ?? ANALYSIS_SESSION_IDLE_TRIM_MS * 2);
  return {
    id,
    trimScrollback: vi.fn(),
    getCurrentScrollback: () => opts.scrollback ?? 10_000,
    getInfo: () => ({
      agentState: opts.agentState,
      lastInputTime: at,
      lastOutputTime: at,
    }),
  };
}

function managerWith(terminals: FakeTerminal[]): PtyManager {
  const manager = new PtyManager();
  const registry = (manager as unknown as { registry: TerminalRegistry }).registry;
  for (const terminal of terminals) {
    registry.add(terminal.id, terminal as unknown as TerminalProcess);
  }
  return manager;
}

describe("PtyManager.trimIdleAnalysisSessions", () => {
  it("trims long-idle sessions to the floor and reports counts", () => {
    const idle = makeTerminal("idle");
    const fresh = makeTerminal("fresh", { idleMs: 1000 });
    const manager = managerWith([idle, fresh]);

    const result = manager.trimIdleAnalysisSessions({ now: NOW });
    expect(result).toEqual({ trimmed: 1, skipped: 1 });
    expect(idle.trimScrollback).toHaveBeenCalledWith(SCROLLBACK_MIN);
    expect(fresh.trimScrollback).not.toHaveBeenCalled();
  });

  it("never trims a terminal whose agent is in an active state, however idle", () => {
    const working = makeTerminal("working", { agentState: "working" });
    const waiting = makeTerminal("waiting", { agentState: "waiting" });
    const directing = makeTerminal("directing", { agentState: "directing" });
    const completed = makeTerminal("completed", { agentState: "completed" });
    const manager = managerWith([working, waiting, directing, completed]);

    const result = manager.trimIdleAnalysisSessions({ now: NOW });
    expect(result).toEqual({ trimmed: 1, skipped: 3 });
    expect(working.trimScrollback).not.toHaveBeenCalled();
    expect(waiting.trimScrollback).not.toHaveBeenCalled();
    expect(directing.trimScrollback).not.toHaveBeenCalled();
    expect(completed.trimScrollback).toHaveBeenCalledWith(SCROLLBACK_MIN);
  });

  it("skips sessions already at or below the trim floor", () => {
    const alreadyMin = makeTerminal("min", { scrollback: SCROLLBACK_MIN });
    const manager = managerWith([alreadyMin]);

    const result = manager.trimIdleAnalysisSessions({ now: NOW });
    expect(result).toEqual({ trimmed: 0, skipped: 1 });
    expect(alreadyMin.trimScrollback).not.toHaveBeenCalled();
  });

  it("honors caller-supplied target and idle threshold", () => {
    const terminal = makeTerminal("t", { idleMs: 5_000, scrollback: 4_000 });
    const manager = managerWith([terminal]);

    const result = manager.trimIdleAnalysisSessions({
      now: NOW,
      targetLines: 2_000,
      idleTrimMs: 4_000,
    });
    expect(result).toEqual({ trimmed: 1, skipped: 0 });
    expect(terminal.trimScrollback).toHaveBeenCalledWith(2_000);
  });
});

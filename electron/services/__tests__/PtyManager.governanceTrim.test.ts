import { describe, expect, it, vi } from "vitest";
import { PtyManager } from "../PtyManager.js";
import { ANALYSIS_SESSION_IDLE_TRIM_MS } from "../../../shared/utils/workerGovernancePolicy.js";
import { SCROLLBACK_BACKGROUND, SCROLLBACK_MIN } from "../../../shared/config/scrollback.js";
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
    /** Model an analysis backend that refuses the resize: the cap never moves. */
    refuseResize?: boolean;
  } = {}
): FakeTerminal {
  const at = NOW - (opts.idleMs ?? ANALYSIS_SESSION_IDLE_TRIM_MS * 2);
  // Mutable so the manager's post-trim re-read sees the effect of its own call,
  // the way a real TerminalProcess does.
  let scrollback = opts.scrollback ?? 10_000;
  return {
    id,
    trimScrollback: vi.fn((target: number) => {
      if (opts.refuseResize) return;
      if (target < scrollback) scrollback = target;
    }),
    getCurrentScrollback: () => scrollback,
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

  it("counts a refused resize as skipped, not trimmed", () => {
    // The count is the only evidence main gets that the trim did anything
    // (#11674), so a backend that declines the resize must not inflate it.
    const refused = makeTerminal("refused", { refuseResize: true });
    const manager = managerWith([refused]);

    const result = manager.trimIdleAnalysisSessions({ now: NOW });

    expect(refused.trimScrollback).toHaveBeenCalled();
    expect(result).toEqual({ trimmed: 0, skipped: 1 });
  });

  it("leaves trimScrollback exempting nothing, agents included (#10948)", () => {
    // The unguarded flatten backs two emergencies: the governor's last lever
    // before a PTY pause, and the "all"-scoped trim main sends once the host
    // has already paused. On a fixed heap the active agents ARE the memory, so
    // adding a governance exemption here reclaims nothing and self-defeats into
    // the visible pause — the shape that got reverted. This must never grow a
    // guard just because its guarded sibling did.
    const working = makeTerminal("working", { agentState: "working" });
    const waiting = makeTerminal("waiting", { agentState: "waiting" });
    const busy = makeTerminal("busy", { agentState: "working", idleMs: 0 });
    const manager = managerWith([working, waiting, busy]);

    const result = manager.trimScrollback(SCROLLBACK_MIN);

    expect(result).toEqual({ trimmed: 3, skipped: 0 });
    for (const terminal of [working, waiting, busy]) {
      expect(terminal.trimScrollback).toHaveBeenCalledWith(SCROLLBACK_MIN);
      expect(terminal.getCurrentScrollback()).toBe(SCROLLBACK_MIN);
    }
  });

  it("reports every terminal as skipped when agents hold them all", () => {
    // The tier-1 shape from #11674: a machine full of working agents. The pass
    // must be a no-op that says so, so a zero delta upstream is attributable to
    // deliberate protection rather than to a lever that failed.
    const terminals = ["a", "b", "c"].map((id) => makeTerminal(id, { agentState: "working" }));
    const manager = managerWith(terminals);

    const result = manager.trimIdleAnalysisSessions({
      now: NOW,
      targetLines: SCROLLBACK_BACKGROUND,
    });

    expect(result).toEqual({ trimmed: 0, skipped: terminals.length });
    for (const terminal of terminals) {
      expect(terminal.trimScrollback).not.toHaveBeenCalled();
      expect(terminal.getCurrentScrollback()).toBeGreaterThan(SCROLLBACK_BACKGROUND);
    }
  });
});

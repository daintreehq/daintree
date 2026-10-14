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
});

describe("PtyManager drive lease", () => {
  function managerWith(projects: Record<string, string | null | undefined>) {
    const manager = Object.create(PtyManager.prototype) as PtyManager;
    Object.defineProperty(manager, "registry", {
      value: {
        get: (id: string) =>
          id in projects ? { getInfo: () => ({ projectId: projects[id] }) } : undefined,
      },
      configurable: true,
    });
    Object.defineProperty(manager, "driveLeases", {
      value: new Map(),
      writable: true,
      configurable: true,
    });
    return manager;
  }

  const LOCAL_WINDOW = 3;
  const HOLDER = -7;
  const OTHER_REMOTE = -9;

  it("arbitrates nothing until a lease names the project", () => {
    const manager = managerWith({ a1: "project-a", loose: null });
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(true);
    manager.setDriveLeases([{ projectId: "project-b", leaseId: 1, holderConnection: HOLDER }]);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(true);
    // No known project: not spawned yet, or never filed.
    expect(manager.mayDriveFrom("loose", OTHER_REMOTE)).toBe(true);
    expect(manager.mayDriveFrom("unknown", OTHER_REMOTE)).toBe(true);
  });

  it("lets only the remote holder's connection drive, including this machine's windows", () => {
    const manager = managerWith({ a1: "project-a" });
    manager.setDriveLeases([{ projectId: "project-a", leaseId: 5, holderConnection: HOLDER }]);
    expect(manager.mayDriveFrom("a1", HOLDER, 5)).toBe(true);
    expect(manager.mayDriveFrom("a1", HOLDER)).toBe(true);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(false);
    expect(manager.mayDriveFrom("a1", LOCAL_WINDOW)).toBe(false);
  });

  it("lets every local window drive when this machine holds, and no remote port", () => {
    const manager = managerWith({ a1: "project-a" });
    manager.setDriveLeases([{ projectId: "project-a", leaseId: 5, holderConnection: null }]);
    expect(manager.mayDriveFrom("a1", LOCAL_WINDOW)).toBe(true);
    expect(manager.mayDriveFrom("a1", LOCAL_WINDOW + 1)).toBe(true);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(false);
  });

  it("refuses work stamped with a lease a takeover replaced, and trusts a newer one", () => {
    const manager = managerWith({ a1: "project-a" });
    manager.setDriveLeases([{ projectId: "project-a", leaseId: 5, holderConnection: HOLDER }]);
    // Queued before the takeover that produced lease 5.
    expect(manager.mayDriveFrom("a1", HOLDER, 4)).toBe(false);
    // Main granted lease 6 to another endpoint; the table has yet to hear.
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE, 6)).toBe(true);

    manager.setDriveLeases([]);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(true);
  });
});

/**
 * `PtyManager.updateWorktreeId` is where a renderer-side move becomes the
 * authoritative record the fleet palette groups by (#12060), and where the
 * ownership identity is checked.
 *
 * The check lands here rather than in main because this is the only place both
 * halves are known synchronously — naming the terminal's project in main would
 * have cost an await, and with it the FIFO ordering that makes two rapid moves
 * settle on the second one.
 */
describe("PtyManager.updateWorktreeId", () => {
  function managerWith(record: { projectId?: string | null } | undefined) {
    const setWorktreeId = vi.fn();
    const terminal = record
      ? { getInfo: () => ({ projectId: record.projectId }), setWorktreeId }
      : undefined;
    const manager = Object.create(PtyManager.prototype) as PtyManager;
    Object.defineProperty(manager, "registry", {
      value: { get: (id: string) => (id === "t1" ? terminal : undefined) },
      configurable: true,
    });
    return { manager, setWorktreeId };
  }

  it("writes the move onto the record when the sender owns the run", () => {
    const { manager, setWorktreeId } = managerWith({ projectId: "project-a" });

    manager.updateWorktreeId("t1", "/repo/.worktrees/feature", "project-a");

    expect(setWorktreeId).toHaveBeenCalledWith("/repo/.worktrees/feature");
  });

  it("refuses a move for a run owned by another project", () => {
    // The fleet snapshot pushes every run to every view, so a foreign terminal
    // id is always in reach. Without this the palette could report project B's
    // run paired with one of project A's worktrees.
    const { manager, setWorktreeId } = managerWith({ projectId: "project-b" });

    manager.updateWorktreeId("t1", "/project-a/.worktrees/feature", "project-a");

    expect(setWorktreeId).not.toHaveBeenCalled();
  });

  it("treats null as an identity, not a wildcard, in both directions", () => {
    // An unbound window (Cmd+N on the project picker) reaches its own
    // projectless terminals and nothing else; a project-owned sender must not
    // reach a projectless run either.
    const unbound = managerWith({ projectId: undefined });
    unbound.manager.updateWorktreeId("t1", "/repo", null);
    expect(unbound.setWorktreeId).toHaveBeenCalledWith("/repo");

    const owned = managerWith({ projectId: "project-a" });
    owned.manager.updateWorktreeId("t1", "/repo", null);
    expect(owned.setWorktreeId).not.toHaveBeenCalled();

    const projectless = managerWith({ projectId: undefined });
    projectless.manager.updateWorktreeId("t1", "/repo", "project-a");
    expect(projectless.setWorktreeId).not.toHaveBeenCalled();
  });

  it("carries an explicit clear through to the record", () => {
    const { manager, setWorktreeId } = managerWith({ projectId: "project-a" });

    manager.updateWorktreeId("t1", null, "project-a");

    expect(setWorktreeId).toHaveBeenCalledWith(null);
  });

  it("is a no-op for a run that has already gone", () => {
    // Never a synthetic record: the renderer store keeps the filing either way.
    const { manager, setWorktreeId } = managerWith(undefined);

    manager.updateWorktreeId("gone", "/repo", "project-a");

    expect(setWorktreeId).not.toHaveBeenCalled();
  });
});

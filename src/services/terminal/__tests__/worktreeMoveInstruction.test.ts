import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentState } from "@/types";

const mockSubmit = vi.fn().mockResolvedValue(undefined);
const mockGetAgentState = vi.fn<(id: string) => AgentState | undefined>();
// A SET per panel, mirroring `managed.agentStateSubscribers` in the real
// service. Keying by panel id alone would let a re-registration silently
// replace the previous listener, which is exactly how a leaked job stayed
// invisible: the real service keeps both, and both fire.
const stateListeners = new Map<string, Set<(state: AgentState) => void>>();
const exitListeners = new Map<string, Set<(code: number) => void>>();
const disposedState: string[] = [];
const disposedExit: string[] = [];

/**
 * Mirrors the real `addAgentStateListener`, which invokes its callback
 * *synchronously* when the state is already known — before it has returned the
 * disposer. That reentrancy is the trap the scheduler has to survive.
 */
let fireImmediatelyWith: AgentState | undefined;

let destroyedListener: ((id: string) => void) | null = null;
/** Panels the service has an instance for. Liveness is now part of the contract. */
const liveInstances = new Set<string>();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: (id: string) => (liveInstances.has(id) ? { id } : null),
    addInstanceDestroyedListener: (cb: (id: string) => void) => {
      destroyedListener = cb;
      return () => {
        destroyedListener = null;
      };
    },
    getAgentState: (id: string) => mockGetAgentState(id),
    addAgentStateListener: (id: string, cb: (state: AgentState) => void) => {
      const set = stateListeners.get(id) ?? new Set();
      set.add(cb);
      stateListeners.set(id, set);
      if (fireImmediatelyWith !== undefined) cb(fireImmediatelyWith);
      return () => {
        disposedState.push(id);
        set.delete(cb);
      };
    },
    addExitListener: (id: string, cb: (code: number) => void) => {
      const set = exitListeners.get(id) ?? new Set();
      set.add(cb);
      exitListeners.set(id, set);
      return () => {
        disposedExit.push(id);
        set.delete(cb);
      };
    },
  },
}));

vi.mock("@/clients", () => ({
  terminalClient: { submit: (...args: unknown[]) => mockSubmit(...args) },
}));

const worktrees = new Map<string, { id: string; path: string }>();
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => ({ getState: () => ({ worktrees }) }),
}));

/** Notify every live subscriber, the way the real service's Set does. */
function fireState(id: string, state: AgentState): void {
  for (const cb of [...(stateListeners.get(id) ?? [])]) cb(state);
}

function fireExit(id: string, code = 0): void {
  for (const cb of [...(exitListeners.get(id) ?? [])]) cb(code);
}

/** How many state listeners are still registered for a panel. */
function liveStateListeners(id: string): number {
  return stateListeners.get(id)?.size ?? 0;
}

/** How many exit listeners are still registered for a panel. */
function liveExitListeners(id: string): number {
  return exitListeners.get(id)?.size ?? 0;
}

const {
  queueWorktreeMoveInstruction,
  cancelWorktreeMoveInstruction,
  hasPendingWorktreeMoveInstruction,
  buildWorktreeMoveInstruction,
  __resetWorktreeMoveInstructions,
} = await import("../worktreeMoveInstruction");

beforeEach(() => {
  vi.clearAllMocks();
  stateListeners.clear();
  exitListeners.clear();
  disposedState.length = 0;
  disposedExit.length = 0;
  fireImmediatelyWith = undefined;
  worktrees.clear();
  worktrees.set("wt-b", { id: "wt-b", path: "/repo/wt-b" });
  liveInstances.clear();
  liveInstances.add("p1");
  liveInstances.add("p2");
  destroyedListener = null;
  mockGetAgentState.mockReturnValue("working");
});

afterEach(() => {
  __resetWorktreeMoveInstructions();
});

describe("queueWorktreeMoveInstruction", () => {
  it("submits immediately when the agent is already idle", () => {
    mockGetAgentState.mockReturnValue("idle");

    expect(queueWorktreeMoveInstruction("p1", "wt-b")).toBe(true);

    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /repo/wt-b");
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("submits immediately when the agent is waiting", () => {
    mockGetAgentState.mockReturnValue("waiting");

    queueWorktreeMoveInstruction("p1", "wt-b");

    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it("queues instead of interrupting a working agent", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(true);
  });

  it("delivers once the agent reports idle", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    fireState("p1", "idle");

    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /repo/wt-b");
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("stays queued through states that are not idle or waiting", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    fireState("p1", "working");
    fireState("p1", "directing");
    fireState("p1", "completed");

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(true);
  });

  it("delivers exactly once even if idle is reported repeatedly", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    fireState("p1", "idle");
    fireState("p1", "waiting");
    fireState("p1", "idle");

    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it("never submits on a timer, however long the agent works", () => {
    // #11840's helper injected blindly after 30s. Landing the sentence
    // mid-turn is the one failure mode this feature is not allowed to have.
    vi.useFakeTimers();
    try {
      queueWorktreeMoveInstruction("p1", "wt-b");
      // Stronger than advancing a fixed span: no timer exists to fire, so no
      // fallback delay however long, rather than "longer than the one we tried".
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(30_000);
      expect(mockSubmit).not.toHaveBeenCalled();
      expect(hasPendingWorktreeMoveInstruction("p1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes when the listener fires before it returns its disposer", () => {
    // The synchronous-callback path: `deliver()` runs while the disposer is
    // still the no-op placeholder, so the unsubscribe has to happen after.
    fireImmediatelyWith = "idle";

    expect(queueWorktreeMoveInstruction("p1", "wt-b")).toBe(true);

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(disposedState).toContain("p1");
    expect(liveStateListeners("p1")).toBe(0);
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("refuses to queue against a panel with no renderer instance", () => {
    // Returning `true` here would hide the banner while nothing was listening.
    liveInstances.delete("p1");

    expect(queueWorktreeMoveInstruction("p1", "wt-b")).toBe(false);

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
    expect(liveStateListeners("p1")).toBe(0);
  });

  it("refuses to queue against a destination that cannot be resolved", () => {
    expect(queueWorktreeMoveInstruction("p1", "wt-gone")).toBe(false);

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("resolves the destination path at delivery, not at queue time", () => {
    // The path can be corrected under a stable id (a rename the host re-reports).
    queueWorktreeMoveInstruction("p1", "wt-b");
    worktrees.set("wt-b", { id: "wt-b", path: "/moved/wt-b" });

    fireState("p1", "idle");

    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /moved/wt-b");
  });

  it("sends nothing when a physical worktree move replaces the destination id", () => {
    // Worktree ids are normalized absolute paths, so `git worktree move` retires
    // the old id and introduces a new one rather than editing a path in place.
    // Failing closed is the point: no fallback, no guessed path, no message.
    queueWorktreeMoveInstruction("p1", "wt-b");
    worktrees.delete("wt-b");
    worktrees.set("/repo/wt-b-renamed", { id: "/repo/wt-b-renamed", path: "/repo/wt-b-renamed" });

    fireState("p1", "idle");

    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("sends nothing when the destination vanishes before the agent frees up", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");
    worktrees.delete("wt-b");

    fireState("p1", "idle");

    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("drops the instruction when the process exits first", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    fireExit("p1");

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
    expect(disposedState).toContain("p1");
  });

  it("replaces an earlier instruction for the same panel", () => {
    // Regression: the replacement used to overwrite the map entry while the
    // first job's listeners stayed live on the service, so a single idle
    // delivered BOTH sentences — the second naming a directory the user had
    // already moved on from.
    worktrees.set("wt-c", { id: "wt-c", path: "/repo/wt-c" });
    queueWorktreeMoveInstruction("p1", "wt-b");
    queueWorktreeMoveInstruction("p1", "wt-c");

    // The superseded job must be gone from the service, not merely unreachable.
    expect(liveStateListeners("p1")).toBe(1);

    fireState("p1", "idle");

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /repo/wt-c");
  });

  it("leaves no listener behind once an instruction has been delivered", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");
    expect(liveStateListeners("p1")).toBe(1);

    fireState("p1", "idle");

    expect(liveStateListeners("p1")).toBe(0);
  });

  it("deregisters the superseded job's exit listener too", () => {
    // Counting is what makes this real: firing every listener would pass
    // whether or not the stale one survived, because the replacement's own
    // listener clears `pending` anyway.
    worktrees.set("wt-c", { id: "wt-c", path: "/repo/wt-c" });
    queueWorktreeMoveInstruction("p1", "wt-b");
    expect(liveExitListeners("p1")).toBe(1);

    queueWorktreeMoveInstruction("p1", "wt-c");

    expect(liveExitListeners("p1")).toBe(1);
  });

  it("keeps instructions for different panels independent", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");
    queueWorktreeMoveInstruction("p2", "wt-b");

    cancelWorktreeMoveInstruction("p1");

    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
    expect(hasPendingWorktreeMoveInstruction("p2")).toBe(true);
  });

  it("survives a submit rejection without retrying", async () => {
    mockSubmit.mockRejectedValueOnce(new Error("pty gone"));
    mockGetAgentState.mockReturnValue("idle");

    queueWorktreeMoveInstruction("p1", "wt-b");
    await Promise.resolve();

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });
});

describe("instance teardown", () => {
  it("drops the instruction when the renderer instance is destroyed", () => {
    // `destroy()` clears the exit subscribers instead of firing them, so a
    // restart or a close gives the scheduler no signal from the exit path.
    queueWorktreeMoveInstruction("p1", "wt-b");
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(true);

    destroyedListener?.("p1");

    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
    expect(liveStateListeners("p1")).toBe(0);
    expect(liveExitListeners("p1")).toBe(0);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("leaves other panels' instructions alone on teardown", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");
    queueWorktreeMoveInstruction("p2", "wt-b");

    destroyedListener?.("p1");

    expect(hasPendingWorktreeMoveInstruction("p2")).toBe(true);
  });
});

describe("cancelWorktreeMoveInstruction", () => {
  it("disposes both listeners", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    cancelWorktreeMoveInstruction("p1");

    expect(disposedState).toContain("p1");
    expect(disposedExit).toContain("p1");
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("is a no-op for a panel with nothing pending", () => {
    expect(() => cancelWorktreeMoveInstruction("p-none")).not.toThrow();
  });

  it("does not let a stale token cancel a replacement instruction", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");
    queueWorktreeMoveInstruction("p1", "wt-b");

    // Token 1 belonged to the job the second queue already replaced.
    cancelWorktreeMoveInstruction("p1", 1);

    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(true);
  });
});

describe("buildWorktreeMoveInstruction", () => {
  it("names the directory exactly once, on one line", () => {
    // The invariant, not the literal: a copied string would only re-assert the
    // implementation. What matters is that the agent gets one unambiguous
    // instruction carrying the path verbatim.
    const path = "/repo/wt-b";
    const message = buildWorktreeMoveInstruction(path);

    expect(message.split(path)).toHaveLength(2);
    expect(message.includes("\n")).toBe(false);
    expect(message.trim()).toBe(message);
  });

  it("does not leak a different destination's path", () => {
    expect(buildWorktreeMoveInstruction("/repo/wt-c")).not.toContain("/repo/wt-b");
  });
});

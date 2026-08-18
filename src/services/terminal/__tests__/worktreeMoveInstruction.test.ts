import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentState } from "@/types";

const mockSubmit = vi.fn().mockResolvedValue(undefined);
const mockGetAgentState = vi.fn<(id: string) => AgentState | undefined>();
const stateListeners = new Map<string, (state: AgentState) => void>();
const exitListeners = new Map<string, (code: number) => void>();
const disposedState: string[] = [];
const disposedExit: string[] = [];

/**
 * Mirrors the real `addAgentStateListener`, which invokes its callback
 * *synchronously* when the state is already known — before it has returned the
 * disposer. That reentrancy is the trap the scheduler has to survive.
 */
let fireImmediatelyWith: AgentState | undefined;

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getAgentState: (id: string) => mockGetAgentState(id),
    addAgentStateListener: (id: string, cb: (state: AgentState) => void) => {
      stateListeners.set(id, cb);
      if (fireImmediatelyWith !== undefined) cb(fireImmediatelyWith);
      return () => {
        disposedState.push(id);
        stateListeners.delete(id);
      };
    },
    addExitListener: (id: string, cb: (code: number) => void) => {
      exitListeners.set(id, cb);
      return () => {
        disposedExit.push(id);
        exitListeners.delete(id);
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

    stateListeners.get("p1")?.("idle");

    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /repo/wt-b");
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("stays queued through states that are not idle or waiting", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    stateListeners.get("p1")?.("working");
    stateListeners.get("p1")?.("directing");
    stateListeners.get("p1")?.("completed");

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(true);
  });

  it("delivers exactly once even if idle is reported repeatedly", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    const listener = stateListeners.get("p1");
    listener?.("idle");
    listener?.("waiting");
    listener?.("idle");

    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it("never submits on a timer, however long the agent works", () => {
    // #11840's helper injected blindly after 30s. Landing the sentence
    // mid-turn is the one failure mode this feature is not allowed to have.
    vi.useFakeTimers();
    try {
      queueWorktreeMoveInstruction("p1", "wt-b");
      vi.advanceTimersByTime(30_000);
      expect(mockSubmit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60 * 60_000);
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
    expect(stateListeners.has("p1")).toBe(false);
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("refuses to queue against a destination that cannot be resolved", () => {
    expect(queueWorktreeMoveInstruction("p1", "wt-gone")).toBe(false);

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
  });

  it("resolves the destination path at delivery, not at queue time", () => {
    // A worktree can be physically relocated while the agent finishes its turn.
    queueWorktreeMoveInstruction("p1", "wt-b");
    worktrees.set("wt-b", { id: "wt-b", path: "/moved/wt-b" });

    stateListeners.get("p1")?.("idle");

    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /moved/wt-b");
  });

  it("sends nothing when the destination vanishes before the agent frees up", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");
    worktrees.delete("wt-b");

    stateListeners.get("p1")?.("idle");

    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("drops the instruction when the process exits first", () => {
    queueWorktreeMoveInstruction("p1", "wt-b");

    exitListeners.get("p1")?.(0);

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(hasPendingWorktreeMoveInstruction("p1")).toBe(false);
    expect(disposedState).toContain("p1");
  });

  it("replaces an earlier instruction for the same panel", () => {
    worktrees.set("wt-c", { id: "wt-c", path: "/repo/wt-c" });
    queueWorktreeMoveInstruction("p1", "wt-b");
    queueWorktreeMoveInstruction("p1", "wt-c");

    stateListeners.get("p1")?.("idle");

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith("p1", "Please continue in the directory /repo/wt-c");
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
  it("is a single plain sentence naming the directory", () => {
    expect(buildWorktreeMoveInstruction("/repo/wt-b")).toBe(
      "Please continue in the directory /repo/wt-b"
    );
  });
});

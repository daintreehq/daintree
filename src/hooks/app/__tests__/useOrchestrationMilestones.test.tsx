// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const milestonesMock = {
  get: vi.fn(() => Promise.resolve({} as Record<string, boolean>)),
  markShown: vi.fn(() => Promise.resolve()),
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: { milestones: milestonesMock },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "") }));
import { notify as notifyMock } from "@/lib/notify";

vi.mock("../../useElectron", () => ({
  isElectronAvailable: () => true,
}));

type TerminalLike = { id?: string; kind?: string; agentState?: string };
type WorktreeLike = { prState?: string };
type RecipeLike = { lastUsedAt?: number };

let terminalState = {
  panelsById: {} as Record<string, TerminalLike>,
  panelIds: [] as string[],
};
let terminalSubscribers: Array<(state: typeof terminalState, prev: typeof terminalState) => void> =
  [];

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => terminalState,
    subscribe: (fn: (state: typeof terminalState, prev: typeof terminalState) => void) => {
      terminalSubscribers.push(fn);
      return () => {
        terminalSubscribers = terminalSubscribers.filter((s) => s !== fn);
      };
    },
  },
}));

let worktreeState = { worktrees: new Map<string, WorktreeLike>() };
let worktreeSubscribers: Array<(state: typeof worktreeState, prev: typeof worktreeState) => void> =
  [];

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => worktreeState,
    subscribe: (fn: (state: typeof worktreeState, prev: typeof worktreeState) => void) => {
      worktreeSubscribers.push(fn);
      return () => {
        worktreeSubscribers = worktreeSubscribers.filter((s) => s !== fn);
      };
    },
  }),
}));

let recipeState = { recipes: [] as RecipeLike[] };
let recipeSubscribers: Array<(state: typeof recipeState, prev: typeof recipeState) => void> = [];

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => recipeState,
    subscribe: (fn: (state: typeof recipeState, prev: typeof recipeState) => void) => {
      recipeSubscribers.push(fn);
      return () => {
        recipeSubscribers = recipeSubscribers.filter((s) => s !== fn);
      };
    },
  },
}));

import { useOrchestrationMilestones } from "../useOrchestrationMilestones";

describe("useOrchestrationMilestones", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    terminalState = { panelsById: {}, panelIds: [] };
    worktreeState = { worktrees: new Map() };
    recipeState = { recipes: [] };
    terminalSubscribers = [];
    worktreeSubscribers = [];
    recipeSubscribers = [];
    milestonesMock.get.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates milestone state from IPC on mount", async () => {
    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(milestonesMock.get).toHaveBeenCalledOnce();
  });

  it("silently marks already-achieved milestones during reconciliation", async () => {
    terminalState = {
      panelsById: { t1: { id: "t1", kind: "agent", agentState: "completed" } },
      panelIds: ["t1"],
    };

    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    expect(milestonesMock.markShown).toHaveBeenCalledWith("first-agent-completed");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires toast when agent completes for the first time via subscription", async () => {
    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    const prev = {
      panelsById: { t1: { id: "t1", kind: "agent", agentState: "working" } } as Record<
        string,
        TerminalLike
      >,
      panelIds: ["t1"],
    };
    const next = {
      panelsById: { t1: { id: "t1", kind: "agent", agentState: "completed" } } as Record<
        string,
        TerminalLike
      >,
      panelIds: ["t1"],
    };
    for (const sub of terminalSubscribers) {
      sub(next, prev);
    }

    expect(milestonesMock.markShown).toHaveBeenCalledWith("first-agent-completed");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "First task complete",
        duration: 5000,
      })
    );
  });

  it("does not fire toast for already-shown milestones", async () => {
    milestonesMock.get.mockResolvedValue({ "first-agent-completed": true });

    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    const prev = {
      panelsById: { t1: { id: "t1", kind: "agent", agentState: "working" } } as Record<
        string,
        TerminalLike
      >,
      panelIds: ["t1"],
    };
    const next = {
      panelsById: { t1: { id: "t1", kind: "agent", agentState: "completed" } } as Record<
        string,
        TerminalLike
      >,
      panelIds: ["t1"],
    };
    for (const sub of terminalSubscribers) {
      sub(next, prev);
    }

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires toast when PR is merged via subscription", async () => {
    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    const prev = { worktrees: new Map([["wt1", { prState: "open" }]]) };
    const next = { worktrees: new Map([["wt1", { prState: "merged" }]]) };
    for (const sub of worktreeSubscribers) {
      sub(next, prev);
    }

    expect(milestonesMock.markShown).toHaveBeenCalledWith("first-pr-merged");
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Shipped" }));
  });

  it("fires toast when recipe is used via subscription", async () => {
    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    const prev = { recipes: [{ lastUsedAt: undefined }] };
    const next = { recipes: [{ lastUsedAt: Date.now() }] };
    for (const sub of recipeSubscribers) {
      sub(next, prev);
    }

    expect(milestonesMock.markShown).toHaveBeenCalledWith("first-recipe-used");
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Recipe activated" }));
  });

  it("staggers multiple simultaneous milestones", async () => {
    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    // Fire two milestones simultaneously
    const prev1 = {
      panelsById: {} as Record<string, TerminalLike>,
      panelIds: [] as string[],
    };
    const next1 = {
      panelsById: {
        t1: { id: "t1", kind: "agent", agentState: "completed" },
        t2: { id: "t2", kind: "agent", agentState: "working" },
        t3: { id: "t3", kind: "agent", agentState: "working" },
        t4: { id: "t4", kind: "agent", agentState: "working" },
      } as Record<string, TerminalLike>,
      panelIds: ["t1", "t2", "t3", "t4"],
    };
    for (const sub of terminalSubscribers) {
      sub(next1, prev1);
    }

    // First toast fires immediately
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // Second fires after stagger delay
    await vi.advanceTimersByTimeAsync(5500);
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing when isStateLoaded is false", async () => {
    renderHook(() => useOrchestrationMilestones(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(milestonesMock.get).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions and event listeners on unmount", async () => {
    const { unmount } = renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    expect(terminalSubscribers).toHaveLength(1);
    expect(worktreeSubscribers).toHaveLength(1);
    expect(recipeSubscribers).toHaveLength(1);

    unmount();

    expect(terminalSubscribers).toHaveLength(0);
    expect(worktreeSubscribers).toHaveLength(0);
    expect(recipeSubscribers).toHaveLength(0);
    expect(window.removeEventListener).toHaveBeenCalledWith(
      "daintree:context-injected",
      expect.any(Function)
    );
  });
});

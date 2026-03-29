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

const notifyMock = vi.fn(() => "");
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("../../useElectron", () => ({
  isElectronAvailable: () => true,
}));

type TerminalLike = { kind?: string; agentState?: string };
type WorktreeLike = { prState?: string };
type RecipeLike = { lastUsedAt?: number };

let terminalState = { terminals: [] as TerminalLike[] };
let terminalSubscribers: Array<(state: typeof terminalState, prev: typeof terminalState) => void> =
  [];

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
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

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: {
    getState: () => worktreeState,
    subscribe: (fn: (state: typeof worktreeState, prev: typeof worktreeState) => void) => {
      worktreeSubscribers.push(fn);
      return () => {
        worktreeSubscribers = worktreeSubscribers.filter((s) => s !== fn);
      };
    },
  },
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

// Reset the module-level guard between tests
let useOrchestrationMilestones: (isStateLoaded: boolean) => void;

describe("useOrchestrationMilestones", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    terminalState = { terminals: [] };
    worktreeState = { worktrees: new Map() };
    recipeState = { recipes: [] };
    terminalSubscribers = [];
    worktreeSubscribers = [];
    recipeSubscribers = [];
    milestonesMock.get.mockResolvedValue({});

    // Re-import to reset module-level guard
    vi.resetModules();
    const mod = await import("../useOrchestrationMilestones");
    useOrchestrationMilestones = mod.useOrchestrationMilestones;
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
    terminalState = { terminals: [{ kind: "agent", agentState: "completed" }] };

    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    expect(milestonesMock.markShown).toHaveBeenCalledWith("first-agent-completed");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires toast when agent completes for the first time via subscription", async () => {
    renderHook(() => useOrchestrationMilestones(true));
    await vi.advanceTimersByTimeAsync(0);

    const prev = { terminals: [{ kind: "agent", agentState: "working" }] };
    const next = { terminals: [{ kind: "agent", agentState: "completed" }] };
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

    const prev = { terminals: [{ kind: "agent", agentState: "working" }] };
    const next = { terminals: [{ kind: "agent", agentState: "completed" }] };
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
    const prev1 = { terminals: [] as TerminalLike[] };
    const next1 = {
      terminals: [
        { kind: "agent", agentState: "completed" },
        { kind: "agent", agentState: "working" },
        { kind: "agent", agentState: "working" },
        { kind: "agent", agentState: "working" },
      ],
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
});

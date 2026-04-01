// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const onboardingMock = {
  get: vi.fn(() => Promise.resolve({ completed: true })),
  getChecklist: vi.fn(() =>
    Promise.resolve({
      items: {
        openedProject: false,
        launchedAgent: false,
        createdWorktree: false,
      },
      dismissed: false,
      celebrationShown: false,
    })
  ),
  markChecklistItem: vi.fn(() => Promise.resolve()),
  dismissChecklist: vi.fn(() => Promise.resolve()),
  markChecklistCelebrationShown: vi.fn(() => Promise.resolve()),
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: { onboarding: onboardingMock },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "") }));

vi.mock("../../useElectron", () => ({
  isElectronAvailable: () => true,
}));

type TerminalLike = { kind?: string; agentState?: string };
type WorktreeLike = { prState?: string };

let projectState = { currentProject: null as string | null };
let projectSubscribers: Array<(state: typeof projectState, prev: typeof projectState) => void> = [];

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => projectState,
    subscribe: (fn: (state: typeof projectState, prev: typeof projectState) => void) => {
      projectSubscribers.push(fn);
      return () => {
        projectSubscribers = projectSubscribers.filter((s) => s !== fn);
      };
    },
  },
}));

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

import { useGettingStartedChecklist } from "../useGettingStartedChecklist";

describe("useGettingStartedChecklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    projectState = { currentProject: null };
    terminalState = { terminals: [] };
    worktreeState = { worktrees: new Map() };
    projectSubscribers = [];
    terminalSubscribers = [];
    worktreeSubscribers = [];
    onboardingMock.get.mockResolvedValue({ completed: true });
    onboardingMock.getChecklist.mockResolvedValue({
      items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      dismissed: false,
      celebrationShown: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets up subscriptions when isStateLoaded is true", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await vi.advanceTimersByTimeAsync(0);

    expect(projectSubscribers).toHaveLength(1);
    expect(terminalSubscribers).toHaveLength(1);
    expect(worktreeSubscribers).toHaveLength(1);
  });

  it("does not set up subscriptions when isStateLoaded is false", async () => {
    renderHook(() => useGettingStartedChecklist(false));
    await vi.advanceTimersByTimeAsync(0);

    expect(projectSubscribers).toHaveLength(0);
    expect(terminalSubscribers).toHaveLength(0);
    expect(worktreeSubscribers).toHaveLength(0);
  });

  it("cleans up all subscriptions on unmount", async () => {
    const { unmount } = renderHook(() => useGettingStartedChecklist(true));
    await vi.advanceTimersByTimeAsync(0);

    expect(projectSubscribers).toHaveLength(1);
    expect(terminalSubscribers).toHaveLength(1);
    expect(worktreeSubscribers).toHaveLength(1);

    unmount();

    expect(projectSubscribers).toHaveLength(0);
    expect(terminalSubscribers).toHaveLength(0);
    expect(worktreeSubscribers).toHaveLength(0);
  });

  it("marks openedProject when project store fires", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await vi.advanceTimersByTimeAsync(0);

    act(() => {
      const prev = { currentProject: null };
      const next = { currentProject: "/some/project" };
      for (const sub of projectSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("openedProject");
  });

  it("marks launchedAgent when terminal store fires", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await vi.advanceTimersByTimeAsync(0);

    act(() => {
      const prev = { terminals: [] as TerminalLike[] };
      const next = { terminals: [{ kind: "agent", agentState: "idle" }] };
      for (const sub of terminalSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("launchedAgent");
  });

  it("marks createdWorktree when worktree store fires", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await vi.advanceTimersByTimeAsync(0);

    act(() => {
      const prev = { worktrees: new Map([["main", {}]]) };
      const next = {
        worktrees: new Map([
          ["main", {}],
          ["wt1", {}],
        ]),
      };
      for (const sub of worktreeSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("createdWorktree");
  });
});

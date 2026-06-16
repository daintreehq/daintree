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
        ranSecondParallelAgent: false,
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

interface NotifyArgs {
  type: string;
  title: string;
  message: string;
  duration?: number;
  transient?: boolean;
}
const { notifyMock, getDisplayComboMock } = vi.hoisted(() => ({
  notifyMock: vi.fn<(args: NotifyArgs) => string>(() => ""),
  getDisplayComboMock: vi.fn<(actionId: string) => string>(() => ""),
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getDisplayCombo: getDisplayComboMock,
  },
}));

vi.mock("../../useElectron", () => ({
  isElectronAvailable: () => true,
}));

let mockReducedMotion = false;
vi.mock("framer-motion", () => ({
  useReducedMotion: () => mockReducedMotion,
}));

type TerminalLike = {
  id?: string;
  kind?: string;
  agentState?: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  everDetectedAgent?: boolean;
};
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

let terminalState: {
  panelsById: Record<string, TerminalLike>;
  panelIds: string[];
  focusedId?: string | null;
} = {
  panelsById: {},
  panelIds: [],
  focusedId: null,
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

import { useGettingStartedChecklist } from "../useGettingStartedChecklist";

describe("useGettingStartedChecklist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockReducedMotion = false;
    projectState = { currentProject: null };
    terminalState = { panelsById: {}, panelIds: [], focusedId: null };
    worktreeState = { worktrees: new Map() };
    projectSubscribers = [];
    terminalSubscribers = [];
    worktreeSubscribers = [];
    onboardingMock.get.mockResolvedValue({ completed: true });
    onboardingMock.getChecklist.mockResolvedValue({
      items: {
        openedProject: false,
        launchedAgent: false,
        createdWorktree: false,
        ranSecondParallelAgent: false,
      },
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      const prev = { currentProject: null };
      const next = { currentProject: "/some/project" };
      for (const sub of projectSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("openedProject");
  });

  it("marks launchedAgent when terminal store fires", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      const prev = {
        panelsById: {} as Record<string, TerminalLike>,
        panelIds: [] as string[],
      };
      const next = {
        panelsById: {
          t1: { id: "t1", kind: "terminal", launchAgentId: "claude", agentState: "idle" },
        } as Record<string, TerminalLike>,
        panelIds: ["t1"],
      };
      for (const sub of terminalSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("launchedAgent");
  });

  it("marks launchedAgent when panel has everDetectedAgent (plain terminal, runtime-detected)", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      const prev = {
        panelsById: {} as Record<string, TerminalLike>,
        panelIds: [] as string[],
      };
      const next = {
        panelsById: {
          t1: { id: "t1", kind: "terminal", everDetectedAgent: true },
        } as Record<string, TerminalLike>,
        panelIds: ["t1"],
      };
      for (const sub of terminalSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("launchedAgent");
  });

  it("does not mark launchedAgent for plain terminal without everDetectedAgent", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      const prev = {
        panelsById: {} as Record<string, TerminalLike>,
        panelIds: [] as string[],
      };
      const next = {
        panelsById: {
          t1: { id: "t1", kind: "terminal" },
        } as Record<string, TerminalLike>,
        panelIds: ["t1"],
      };
      for (const sub of terminalSubscribers) sub(next, prev);
    });

    expect(onboardingMock.markChecklistItem).not.toHaveBeenCalledWith("launchedAgent");
  });

  it("marks createdWorktree when worktree store fires", async () => {
    renderHook(() => useGettingStartedChecklist(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

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

  describe("completion side effects", () => {
    beforeEach(() => {
      // Use real timers so Promise.all hydration microtasks resolve naturally.
      vi.useRealTimers();
      onboardingMock.getChecklist.mockResolvedValue({
        items: {
          openedProject: true,
          launchedAgent: true,
          createdWorktree: true,
          ranSecondParallelAgent: false,
        },
        dismissed: false,
        celebrationShown: false,
      });
    });

    async function flushHydration() {
      // Two microtask rounds for Promise.all + .then chain, then act flush.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("does not emit a toast, read keybinding, or auto-dismiss when the final item completes", async () => {
      // Regression guard for #7499: the on-screen CelebrationConfetti is the
      // sole completion signal. A toast would be redundant (Visible-another-way)
      // and its CTA would point to an action the user just finished (Helpful).
      const { result } = renderHook(() => useGettingStartedChecklist(true));
      await flushHydration();

      expect(result.current.checklist?.items.ranSecondParallelAgent).toBe(false);

      await act(async () => {
        result.current.markItem("ranSecondParallelAgent");
      });

      expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("ranSecondParallelAgent");
      expect(notifyMock).not.toHaveBeenCalled();
      expect(getDisplayComboMock).not.toHaveBeenCalled();
      expect(onboardingMock.dismissChecklist).not.toHaveBeenCalled();
      expect(onboardingMock.markChecklistCelebrationShown).toHaveBeenCalledTimes(1);
      expect(result.current.showCelebration).toBe(true);
    });
  });

  describe("completion behavior", () => {
    beforeEach(() => {
      onboardingMock.getChecklist.mockResolvedValue({
        items: {
          openedProject: true,
          launchedAgent: true,
          createdWorktree: true,
          ranSecondParallelAgent: false,
        },
        dismissed: false,
        celebrationShown: false,
      });
    });

    it("keeps panel visible after all items complete (no auto-dismiss)", async () => {
      const { result } = renderHook(() => useGettingStartedChecklist(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        result.current.markItem("ranSecondParallelAgent");
      });

      // Panel stays visible after completion — no auto-dismiss.
      expect(result.current.visible).toBe(true);
      expect(result.current.checklist?.dismissed).toBe(false);
      // dismissChecklist is NOT called on completion.
      expect(onboardingMock.dismissChecklist).not.toHaveBeenCalled();

      // Advance well past the old 800ms hold — panel remains visible.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.visible).toBe(true);
      expect(result.current.checklist?.dismissed).toBe(false);
    });

    it("onChecklistPush with dismissed:true hides the panel", async () => {
      let pushHandler: ((next: ChecklistStateLike) => void) | null = null;
      const onChecklistPushMock = vi.fn((fn: (next: ChecklistStateLike) => void) => {
        pushHandler = fn;
        return () => {};
      });
      const augmentedMock = onboardingMock as typeof onboardingMock & {
        onChecklistPush: typeof onChecklistPushMock;
      };
      augmentedMock.onChecklistPush = onChecklistPushMock;

      try {
        const { result } = renderHook(() => useGettingStartedChecklist(true));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(result.current.visible).toBe(true);
        expect(pushHandler).not.toBeNull();

        // Push with dismissed:true takes effect immediately.
        await act(async () => {
          pushHandler!({
            items: {
              openedProject: true,
              launchedAgent: true,
              createdWorktree: true,
              ranSecondParallelAgent: true,
            },
            dismissed: true,
            celebrationShown: false,
          });
        });

        expect(result.current.checklist?.dismissed).toBe(true);
        expect(result.current.visible).toBe(false);
      } finally {
        delete (augmentedMock as Partial<typeof augmentedMock>).onChecklistPush;
      }
    });

    it("manual dismiss after completion hides panel and persists dismissal", async () => {
      const { result } = renderHook(() => useGettingStartedChecklist(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        result.current.markItem("ranSecondParallelAgent");
      });
      expect(result.current.visible).toBe(true);

      await act(async () => {
        result.current.dismiss();
      });

      expect(result.current.visible).toBe(false);
      expect(result.current.checklist?.dismissed).toBe(true);
      expect(onboardingMock.dismissChecklist).toHaveBeenCalledTimes(1);

      // Advancing time does not change anything.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(result.current.visible).toBe(false);
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      mockReducedMotion = true;
      onboardingMock.getChecklist.mockResolvedValue({
        items: {
          openedProject: true,
          launchedAgent: true,
          createdWorktree: true,
          ranSecondParallelAgent: false,
        },
        dismissed: false,
        celebrationShown: false,
      });
    });

    it("completes celebration auto-clear in 0ms when reduced motion is preferred", async () => {
      const { result } = renderHook(() => useGettingStartedChecklist(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.showCelebration).toBe(false);

      await act(async () => {
        result.current.markItem("ranSecondParallelAgent");
      });

      expect(result.current.showCelebration).toBe(true);

      // Timer fires immediately (0ms).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.showCelebration).toBe(false);
    });
  });

  describe("auto-collapse", () => {
    const launchedPanel = {
      t1: { id: "t1", kind: "terminal", launchAgentId: "claude", agentState: "idle" },
    } as Record<string, TerminalLike>;
    const plainPanel = { t1: { id: "t1", kind: "terminal" } } as Record<string, TerminalLike>;

    async function mountLoaded() {
      const hook = renderHook(() => useGettingStartedChecklist(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      return hook;
    }

    function fireTerminal(next: typeof terminalState) {
      const prev = { panelsById: {}, panelIds: [], focusedId: null };
      terminalState = next;
      act(() => {
        for (const sub of terminalSubscribers) sub(next, prev);
      });
    }

    it("collapses once the user has launched an agent and focused a panel", async () => {
      const { result } = await mountLoaded();
      expect(result.current.collapsed).toBe(false);

      fireTerminal({ panelsById: launchedPanel, panelIds: ["t1"], focusedId: "t1" });

      expect(result.current.collapsed).toBe(true);
    });

    it("does not collapse when an agent launched but no panel is focused", async () => {
      const { result } = await mountLoaded();

      fireTerminal({ panelsById: launchedPanel, panelIds: ["t1"], focusedId: null });

      expect(onboardingMock.markChecklistItem).toHaveBeenCalledWith("launchedAgent");
      expect(result.current.collapsed).toBe(false);
    });

    it("does not collapse when a panel is focused but no agent has launched", async () => {
      const { result } = await mountLoaded();

      fireTerminal({ panelsById: plainPanel, panelIds: ["t1"], focusedId: "t1" });

      expect(onboardingMock.markChecklistItem).not.toHaveBeenCalledWith("launchedAgent");
      expect(result.current.collapsed).toBe(false);
    });

    it("collapses only once — a later user-expand is not undone by the latch", async () => {
      const { result } = await mountLoaded();

      fireTerminal({ panelsById: launchedPanel, panelIds: ["t1"], focusedId: "t1" });
      expect(result.current.collapsed).toBe(true);

      act(() => result.current.toggleCollapse());
      expect(result.current.collapsed).toBe(false);

      // A later panel event with both conditions still true must not re-collapse.
      fireTerminal({ panelsById: launchedPanel, panelIds: ["t1"], focusedId: "t1" });
      expect(result.current.collapsed).toBe(false);
    });

    it("does not auto-collapse after the user opens it via Help > Getting Started", async () => {
      const { result } = await mountLoaded();

      const showCall = vi
        .mocked(window.addEventListener)
        .mock.calls.find((c) => c[0] === "daintree:show-getting-started");
      expect(showCall).toBeDefined();
      const handleShow = showCall![1] as () => void;

      await act(async () => {
        handleShow();
        await Promise.resolve();
      });
      expect(result.current.collapsed).toBe(false);

      // Even with both engagement conditions now true, the explicit show wins.
      fireTerminal({ panelsById: launchedPanel, panelIds: ["t1"], focusedId: "t1" });
      expect(result.current.collapsed).toBe(false);
    });
  });
});

interface ChecklistStateLike {
  items: {
    openedProject: boolean;
    launchedAgent: boolean;
    createdWorktree: boolean;
    ranSecondParallelAgent: boolean;
  };
  dismissed: boolean;
  celebrationShown: boolean;
}

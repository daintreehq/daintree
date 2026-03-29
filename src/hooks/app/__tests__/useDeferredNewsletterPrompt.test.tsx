// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const onboardingMock = {
  get: vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1,
      completed: true,
      currentStep: null as string | null,
      migratedFromLocalStorage: true,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    })
  ),
  markNewsletterSeen: vi.fn(() => Promise.resolve()),
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    onboarding: onboardingMock,
  },
});

let storeSubscribers: Array<(state: { terminals: Array<{ kind: string }> }) => void> = [];
let storeState = { terminals: [] as Array<{ kind: string }> };

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: () => storeState,
    subscribe: (fn: (state: { terminals: Array<{ kind: string }> }) => void) => {
      storeSubscribers.push(fn);
      return () => {
        storeSubscribers = storeSubscribers.filter((s) => s !== fn);
      };
    },
  },
}));

vi.mock("../../useElectron", () => ({
  isElectronAvailable: () => true,
}));

import { useDeferredNewsletterPrompt } from "../useDeferredNewsletterPrompt";

// Flush promises without advancing timers
async function flushPromises() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useDeferredNewsletterPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    storeSubscribers = [];
    storeState = { terminals: [] };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show when onboarding is not completed", async () => {
    onboardingMock.get.mockResolvedValueOnce({
      schemaVersion: 1,
      completed: false,
      currentStep: "themeSelection",
      migratedFromLocalStorage: true,
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    });

    const { result } = renderHook(() => useDeferredNewsletterPrompt(true, false));
    await flushPromises();

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.visible).toBe(false);
  });

  it("does not show when newsletterPromptSeen is true", async () => {
    onboardingMock.get.mockResolvedValueOnce({
      schemaVersion: 1,
      completed: true,
      currentStep: null,
      migratedFromLocalStorage: true,
      firstRunToastSeen: false,
      newsletterPromptSeen: true,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    });

    const { result } = renderHook(() => useDeferredNewsletterPrompt(true, false));
    await flushPromises();

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.visible).toBe(false);
  });

  it("shows after agent terminal appears and delay elapses (checklist not visible)", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(true, false));
    await flushPromises();

    expect(result.current.visible).toBe(false);

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    expect(result.current.visible).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.visible).toBe(true);
  });

  it("does not show while checklist is visible even after agent launch", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(true, true));
    await flushPromises();

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Should not fire — checklist is still visible (only fallback at 180s would fire)
    expect(result.current.visible).toBe(false);
  });

  it("shows after checklist dismisses with breathing-room delay", async () => {
    const { result, rerender } = renderHook(
      ({ checklistVisible }) => useDeferredNewsletterPrompt(true, checklistVisible),
      { initialProps: { checklistVisible: true } }
    );
    await flushPromises();

    // Agent launches while checklist is visible — should not fire
    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.visible).toBe(false);

    // Checklist dismisses
    rerender({ checklistVisible: false });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.visible).toBe(true);
  });

  it("shows after 3-minute fallback if checklist never dismissed", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(true, true));
    await flushPromises();

    // No agent launch, checklist stays visible
    await act(async () => {
      vi.advanceTimersByTime(179_999);
    });
    expect(result.current.visible).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(true);
  });

  it("does not double-fire if fallback and checklist-dismissed paths both trigger", async () => {
    const { result, rerender } = renderHook(
      ({ checklistVisible }) => useDeferredNewsletterPrompt(true, checklistVisible),
      { initialProps: { checklistVisible: true } }
    );
    await flushPromises();

    // Agent launched
    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    // Advance close to 3 minutes
    await act(async () => {
      vi.advanceTimersByTime(179_000);
    });

    // Checklist dismisses — fires via checklist-dismissed path
    rerender({ checklistVisible: false });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);

    // Dismiss it
    act(() => {
      result.current.dismiss(false);
    });
    expect(result.current.visible).toBe(false);

    // Fallback timer fires — should NOT re-show (firedRef guards)
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.visible).toBe(false);
  });

  it("dismiss calls markNewsletterSeen and hides prompt", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(true, false));
    await flushPromises();

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.visible).toBe(true);

    act(() => {
      result.current.dismiss(false);
    });

    expect(result.current.visible).toBe(false);
    expect(onboardingMock.markNewsletterSeen).toHaveBeenCalledOnce();
  });

  it("cleans up timer on unmount during delay", async () => {
    const { result, unmount } = renderHook(() => useDeferredNewsletterPrompt(true, false));
    await flushPromises();

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.visible).toBe(false);
  });

  it("does not show when isStateLoaded is false", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(false, false));
    await flushPromises();

    expect(result.current.visible).toBe(false);
    expect(onboardingMock.get).not.toHaveBeenCalled();
  });
});

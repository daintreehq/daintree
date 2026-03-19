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
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    });

    const { result } = renderHook(() => useDeferredNewsletterPrompt(true));

    // Flush the IPC promise
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Simulate agent launch
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
        items: { openedProject: false, launchedAgent: false, createdWorktree: false },
      },
    });

    const { result } = renderHook(() => useDeferredNewsletterPrompt(true));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.visible).toBe(false);
  });

  it("shows after agent terminal appears and delay elapses", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(true));

    // Flush hydration
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.visible).toBe(false);

    // Simulate agent launch
    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    // Before delay elapses
    expect(result.current.visible).toBe(false);

    // After delay
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    expect(result.current.visible).toBe(true);
  });

  it("dismiss calls markNewsletterSeen and hides prompt", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(true));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    expect(result.current.visible).toBe(true);

    act(() => {
      result.current.dismiss(false);
    });

    expect(result.current.visible).toBe(false);
    expect(onboardingMock.markNewsletterSeen).toHaveBeenCalledOnce();
  });

  it("cleans up timer on unmount during delay", async () => {
    const { result, unmount } = renderHook(() => useDeferredNewsletterPrompt(true));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Trigger agent detection
    storeState = { terminals: [{ kind: "agent" }] };
    act(() => {
      storeSubscribers.forEach((fn) => fn(storeState));
    });

    // Unmount before delay elapses
    unmount();

    // Advance past the delay — should not throw or update state
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.visible).toBe(false);
  });

  it("does not show when isStateLoaded is false", async () => {
    const { result } = renderHook(() => useDeferredNewsletterPrompt(false));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.visible).toBe(false);
    expect(onboardingMock.get).not.toHaveBeenCalled();
  });
});

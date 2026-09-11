// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HostMemoryPauseSnapshot } from "@shared/types/pty-host";

const { clientMock, announceMock } = vi.hoisted(() => ({
  clientMock: {
    getHostMemoryPause: vi.fn(),
    onHostMemoryPause: vi.fn(),
  },
  announceMock: vi.fn(),
}));

vi.mock("@/clients/terminalClient", () => ({ terminalClient: clientMock }));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { useHostMemoryPauseSync } from "../useHostMemoryPauseSync";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { HOST_MEMORY_PAUSE_COPY } from "@/lib/hostMemoryPauseCopy";

const PAUSED: HostMemoryPauseSnapshot = { active: true, paused: true, stalled: false };
const MONITORING: HostMemoryPauseSnapshot = { active: true, paused: false, stalled: false };
const CLEAR: HostMemoryPauseSnapshot = { active: false, paused: false, stalled: false };

interface PendingPull {
  resolve: (snapshot: HostMemoryPauseSnapshot) => void;
  reject: (error: unknown) => void;
}

type ViewSignal = "revealed" | "warmActivated" | "cached";

const pushListeners = new Set<(snapshot: HostMemoryPauseSnapshot) => void>();
const viewListeners: Record<ViewSignal, Set<() => void>> = {
  revealed: new Set(),
  warmActivated: new Set(),
  cached: new Set(),
};
let pulls: PendingPull[] = [];
let hasFocus: MockInstance<() => boolean>;

function push(snapshot: HostMemoryPauseSnapshot): void {
  act(() => {
    for (const listener of [...pushListeners]) listener(snapshot);
  });
}

function signalView(signal: ViewSignal): void {
  act(() => {
    for (const listener of [...viewListeners[signal]]) listener();
  });
}

function focusView(): void {
  hasFocus.mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

async function resolvePull(index: number, snapshot: HostMemoryPauseSnapshot): Promise<void> {
  await act(async () => {
    pulls[index]!.resolve(snapshot);
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function listenFor(signal: ViewSignal) {
  return (callback: () => void) => {
    viewListeners[signal].add(callback);
    return () => {
      viewListeners[signal].delete(callback);
    };
  };
}

function listenerCounts() {
  return {
    push: pushListeners.size,
    revealed: viewListeners.revealed.size,
    warmActivated: viewListeners.warmActivated.size,
    cached: viewListeners.cached.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  pulls = [];
  pushListeners.clear();
  for (const listeners of Object.values(viewListeners)) listeners.clear();
  announceMock.mockReset();
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useHostMemoryPauseStore.setState({ snapshot: null, visible: false });

  clientMock.getHostMemoryPause.mockReset().mockImplementation(
    () =>
      new Promise<HostMemoryPauseSnapshot>((resolve, reject) => {
        pulls.push({ resolve, reject });
      })
  );
  clientMock.onHostMemoryPause
    .mockReset()
    .mockImplementation((callback: (snapshot: HostMemoryPauseSnapshot) => void) => {
      pushListeners.add(callback);
      return () => {
        pushListeners.delete(callback);
      };
    });

  vi.stubGlobal("electron", {
    app: {
      onViewRevealed: listenFor("revealed"),
      onViewWarmActivated: listenFor("warmActivated"),
      onViewCached: listenFor("cached"),
    },
  });
});

afterEach(() => {
  cleanup();
  hasFocus.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useHostMemoryPauseSync", () => {
  it("subscribes to pushes before it pulls, so the pull can never leave a gap", () => {
    renderHook(() => useHostMemoryPauseSync());

    const subscribedAt = clientMock.onHostMemoryPause.mock.invocationCallOrder[0]!;
    const pulledAt = clientMock.getHostMemoryPause.mock.invocationCallOrder[0]!;
    expect(subscribedAt).toBeLessThan(pulledAt);
  });

  it("subscribes exactly once under StrictMode and releases everything on unmount", () => {
    const { unmount } = renderHook(() => useHostMemoryPauseSync(), { wrapper: StrictMode });

    expect(listenerCounts()).toEqual({ push: 1, revealed: 1, warmActivated: 1, cached: 1 });

    unmount();
    expect(listenerCounts()).toEqual({ push: 0, revealed: 0, warmActivated: 0, cached: 0 });
  });

  it("shows a pause already under way at mount at once, and silently", async () => {
    renderHook(() => useHostMemoryPauseSync());

    await resolvePull(0, PAUSED);

    expect(useHostMemoryPauseStore.getState()).toMatchObject({ snapshot: PAUSED, visible: true });
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("shows and announces a pushed pause only once it outlives the Doherty gate", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD - 1);
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();

    advance(1);
    expect(useHostMemoryPauseStore.getState().visible).toBe(true);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith(HOST_MEMORY_PAUSE_COPY.announcePaused, "polite");
  });

  it("shows and announces nothing for a pause that clears inside the gate", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD / 2);
    push(CLEAR);
    advance(UI_DOHERTY_THRESHOLD * 2);

    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("stays up without re-announcing through a forced resume and re-pause, then announces the end", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD);
    push(MONITORING);
    advance(UI_DOHERTY_THRESHOLD * 5);
    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD * 5);

    expect(useHostMemoryPauseStore.getState().visible).toBe(true);
    expect(announceMock).toHaveBeenCalledTimes(1);

    push(CLEAR);
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).toHaveBeenCalledTimes(2);
    expect(announceMock).toHaveBeenLastCalledWith(HOST_MEMORY_PAUSE_COPY.announceEnded, "polite");
  });

  it("keeps a pushed pause's original gate deadline and announcement when a reconciling pull lands inside it", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    const pulledAt = UI_DOHERTY_THRESHOLD / 4;
    push(PAUSED);
    advance(pulledAt);
    signalView("revealed");
    await resolvePull(1, PAUSED);

    advance(UI_DOHERTY_THRESHOLD - pulledAt - 1);
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    advance(1);
    expect(useHostMemoryPauseStore.getState().visible).toBe(true);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("drops a pull that a push overtook", async () => {
    renderHook(() => useHostMemoryPauseSync());

    push(PAUSED);
    await resolvePull(0, CLEAR);

    expect(useHostMemoryPauseStore.getState().snapshot).toEqual(PAUSED);
  });

  it("ignores an older pull that resolves after a newer one", async () => {
    renderHook(() => useHostMemoryPauseSync());
    signalView("revealed");

    await resolvePull(1, PAUSED);
    await resolvePull(0, CLEAR);

    expect(useHostMemoryPauseStore.getState().snapshot).toEqual(PAUSED);
  });

  it.each(["revealed", "warmActivated"] as const)(
    "re-pulls on the %s view signal, reconciling without an announcement",
    async (signal) => {
      renderHook(() => useHostMemoryPauseSync());
      await resolvePull(0, PAUSED);
      expect(useHostMemoryPauseStore.getState().visible).toBe(true);

      signalView(signal);
      expect(pulls).toHaveLength(2);
      await resolvePull(1, CLEAR);

      expect(useHostMemoryPauseStore.getState().visible).toBe(false);
      expect(announceMock).not.toHaveBeenCalled();
    }
  );

  it("re-pulls when the page becomes visible again", () => {
    renderHook(() => useHostMemoryPauseSync());
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clientMock.getHostMemoryPause).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clientMock.getHostMemoryPause).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it("lets a pause cached mid-gate go unannounced, even when the view returns before the deadline", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    signalView("cached");
    advance(UI_DOHERTY_THRESHOLD / 2);
    signalView("revealed");
    await resolvePull(1, PAUSED);
    expect(useHostMemoryPauseStore.getState().visible).toBe(true);

    advance(UI_DOHERTY_THRESHOLD * 2);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("holds the pause announcement while the view lacks focus and delivers it once focus returns", async () => {
    hasFocus.mockReturnValue(false);
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD);
    expect(useHostMemoryPauseStore.getState().visible).toBe(true);
    expect(announceMock).not.toHaveBeenCalled();

    focusView();
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith(HOST_MEMORY_PAUSE_COPY.announcePaused, "polite");

    focusView();
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the pause ends before an unfocused view gets focus back", async () => {
    hasFocus.mockReturnValue(false);
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD);
    push(CLEAR);
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);

    focusView();
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("stops listening on unmount and never fires a gate left pending", async () => {
    const { unmount } = renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    unmount();
    advance(UI_DOHERTY_THRESHOLD * 2);

    expect(listenerCounts()).toEqual({ push: 0, revealed: 0, warmActivated: 0, cached: 0 });
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
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

let pushListener: ((snapshot: HostMemoryPauseSnapshot) => void) | null = null;
let viewListeners: Partial<Record<ViewSignal, () => void>> = {};
let pulls: PendingPull[] = [];
let hasFocus: MockInstance<() => boolean>;

function push(snapshot: HostMemoryPauseSnapshot): void {
  act(() => {
    pushListener?.(snapshot);
  });
}

function signalView(signal: ViewSignal): void {
  act(() => {
    viewListeners[signal]?.();
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
    viewListeners[signal] = callback;
    return () => {
      delete viewListeners[signal];
    };
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  pulls = [];
  pushListener = null;
  viewListeners = {};
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
      pushListener = callback;
      return () => {
        pushListener = null;
      };
    });

  (window as unknown as { electron: unknown }).electron = {
    app: {
      onViewRevealed: listenFor("revealed"),
      onViewWarmActivated: listenFor("warmActivated"),
      onViewCached: listenFor("cached"),
    },
  };
});

afterEach(() => {
  cleanup();
  hasFocus.mockRestore();
  vi.useRealTimers();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("useHostMemoryPauseSync", () => {
  it("subscribes to pushes before it pulls, so the pull can never leave a gap", () => {
    renderHook(() => useHostMemoryPauseSync());

    const subscribedAt = clientMock.onHostMemoryPause.mock.invocationCallOrder[0]!;
    const pulledAt = clientMock.getHostMemoryPause.mock.invocationCallOrder[0]!;
    expect(subscribedAt).toBeLessThan(pulledAt);
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

  it("keeps a pushed pause's gate and announcement when a reconciling pull lands inside it", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD / 4);
    signalView("revealed");
    await resolvePull(1, PAUSED);

    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    advance(UI_DOHERTY_THRESHOLD);
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

  it("lets a pause go unannounced when its view is cached mid-gate, then shows it silently on return", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    signalView("cached");
    advance(UI_DOHERTY_THRESHOLD * 2);
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);

    signalView("revealed");
    await resolvePull(1, PAUSED);

    expect(useHostMemoryPauseStore.getState().visible).toBe(true);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("stays silent in a view that doesn't hold focus, while still showing the pause", async () => {
    hasFocus.mockReturnValue(false);
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    advance(UI_DOHERTY_THRESHOLD);
    expect(useHostMemoryPauseStore.getState().visible).toBe(true);

    push(CLEAR);
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("stops listening on unmount and never fires a gate left pending", async () => {
    const { unmount } = renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    unmount();
    advance(UI_DOHERTY_THRESHOLD * 2);

    expect(pushListener).toBeNull();
    expect(viewListeners).toEqual({});
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();
  });
});

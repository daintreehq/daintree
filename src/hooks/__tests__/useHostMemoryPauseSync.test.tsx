// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let pushListener: ((snapshot: HostMemoryPauseSnapshot) => void) | null = null;
let revealListener: (() => void) | null = null;
let pulls: PendingPull[] = [];

function push(snapshot: HostMemoryPauseSnapshot): void {
  act(() => {
    pushListener?.(snapshot);
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

beforeEach(() => {
  vi.useFakeTimers();
  pulls = [];
  pushListener = null;
  revealListener = null;
  announceMock.mockReset();
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
      onViewRevealed: (callback: () => void) => {
        revealListener = callback;
        return () => {
          revealListener = null;
        };
      },
    },
  };
});

afterEach(() => {
  cleanup();
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

  it("drops a pull that a push overtook", async () => {
    renderHook(() => useHostMemoryPauseSync());

    push(PAUSED);
    await resolvePull(0, CLEAR);

    expect(useHostMemoryPauseStore.getState().snapshot).toEqual(PAUSED);
  });

  it("re-pulls when a cached view is revealed, reconciling without an announcement", async () => {
    renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, PAUSED);
    expect(useHostMemoryPauseStore.getState().visible).toBe(true);

    act(() => {
      revealListener?.();
    });
    expect(pulls).toHaveLength(2);
    await resolvePull(1, CLEAR);

    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("ignores an older pull that resolves after a newer one", async () => {
    renderHook(() => useHostMemoryPauseSync());
    act(() => {
      revealListener?.();
    });

    await resolvePull(1, PAUSED);
    await resolvePull(0, CLEAR);

    expect(useHostMemoryPauseStore.getState().snapshot).toEqual(PAUSED);
  });

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

  it("stops listening on unmount and never fires a gate left pending", async () => {
    const { unmount } = renderHook(() => useHostMemoryPauseSync());
    await resolvePull(0, CLEAR);

    push(PAUSED);
    unmount();
    advance(UI_DOHERTY_THRESHOLD * 2);

    expect(pushListener).toBeNull();
    expect(revealListener).toBeNull();
    expect(useHostMemoryPauseStore.getState().visible).toBe(false);
    expect(announceMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeepAwakeState } from "@shared/types";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getState: vi.fn(),
    updateConfig: vi.fn(),
    onStateChanged: vi.fn(),
  },
}));

vi.mock("@/clients/keepAwakeClient", () => ({ keepAwakeClient: clientMock }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { loadKeepAwakeState, useKeepAwakeSync } from "../useKeepAwakeSync";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

function makeState(isBlocking: boolean, revision: number): KeepAwakeState {
  return { config: { enabled: true, onBattery: false }, isBlocking, revision };
}

interface PendingRead {
  resolve: (state: KeepAwakeState) => void;
  reject: (error: unknown) => void;
}

const pushListeners = new Set<(state: KeepAwakeState) => void>();
let reads: PendingRead[] = [];

function push(state: KeepAwakeState): void {
  act(() => {
    for (const listener of [...pushListeners]) listener(state);
  });
}

async function resolveRead(index: number, state: KeepAwakeState): Promise<void> {
  await act(async () => {
    reads[index]!.resolve(state);
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  pushListeners.clear();
  useKeepAwakeStore.setState({ state: null, loadError: null, visible: false });
  clientMock.getState.mockImplementation(
    () =>
      new Promise<KeepAwakeState>((resolve, reject) => {
        reads.push({ resolve, reject });
      })
  );
  clientMock.onStateChanged.mockImplementation((callback: (state: KeepAwakeState) => void) => {
    pushListeners.add(callback);
    return () => {
      pushListeners.delete(callback);
    };
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useKeepAwakeSync", () => {
  it("subscribes before it reads", () => {
    renderHook(() => useKeepAwakeSync());

    expect(clientMock.onStateChanged).toHaveBeenCalledTimes(1);
    expect(clientMock.getState).toHaveBeenCalledTimes(1);
    expect(clientMock.onStateChanged.mock.invocationCallOrder[0]).toBeLessThan(
      clientMock.getState.mock.invocationCallOrder[0]!
    );
  });

  it("shows a hold that was already under way at once", async () => {
    renderHook(() => useKeepAwakeSync());

    await resolveRead(0, makeState(true, 3));

    expect(useKeepAwakeStore.getState().visible).toBe(true);
  });

  it("waits out the Doherty gate before showing a hold that starts later", async () => {
    renderHook(() => useKeepAwakeSync());
    await resolveRead(0, makeState(false, 1));

    push(makeState(true, 2));
    expect(useKeepAwakeStore.getState().visible).toBe(false);

    advance(UI_DOHERTY_THRESHOLD);
    expect(useKeepAwakeStore.getState().visible).toBe(true);
  });

  it("never shows a hold released inside the gate", async () => {
    renderHook(() => useKeepAwakeSync());
    await resolveRead(0, makeState(false, 1));

    push(makeState(true, 2));
    push(makeState(false, 3));
    advance(UI_DOHERTY_THRESHOLD);

    expect(useKeepAwakeStore.getState().visible).toBe(false);
  });

  it("hides at once when the hold is released", async () => {
    renderHook(() => useKeepAwakeSync());
    await resolveRead(0, makeState(true, 1));

    push(makeState(false, 2));

    expect(useKeepAwakeStore.getState().visible).toBe(false);
  });

  it("drops a read that a newer push overtook", async () => {
    renderHook(() => useKeepAwakeSync());

    push(makeState(false, 5));
    await resolveRead(0, makeState(true, 4));

    expect(useKeepAwakeStore.getState().state?.revision).toBe(5);
    expect(useKeepAwakeStore.getState().state?.isBlocking).toBe(false);
    expect(useKeepAwakeStore.getState().visible).toBe(false);
  });

  it("reads again when the page becomes visible", () => {
    renderHook(() => useKeepAwakeSync());

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(clientMock.getState).toHaveBeenCalledTimes(2);
  });

  it("records a failed read, and a later read clears it", async () => {
    renderHook(() => useKeepAwakeSync());

    await act(async () => {
      reads[0]!.reject(new Error("no handler"));
    });
    expect(useKeepAwakeStore.getState().loadError).toBe("no handler");

    const retry = loadKeepAwakeState();
    await resolveRead(1, makeState(false, 1));
    await retry;
    expect(useKeepAwakeStore.getState().loadError).toBeNull();
    expect(useKeepAwakeStore.getState().state?.revision).toBe(1);
  });

  it("leaves no listener or gate behind when unmounted", async () => {
    const { unmount } = renderHook(() => useKeepAwakeSync());
    await resolveRead(0, makeState(false, 1));
    push(makeState(true, 2));

    unmount();
    advance(UI_DOHERTY_THRESHOLD);

    expect(pushListeners.size).toBe(0);
    expect(useKeepAwakeStore.getState().visible).toBe(false);
  });

  it("keeps one listener and shows a hold under StrictMode's double mount", async () => {
    renderHook(() => useKeepAwakeSync(), { wrapper: StrictMode });

    await resolveRead(0, makeState(true, 1));

    expect(useKeepAwakeStore.getState().visible).toBe(true);
    expect(pushListeners.size).toBe(1);
  });
});

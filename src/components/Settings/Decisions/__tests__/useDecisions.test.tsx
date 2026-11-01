// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { useDecisions } from "../useDecisions";

type Listener = (status: DecisionsStatus) => void;

const listeners = new Set<Listener>();
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const setEnabled = vi.fn<() => Promise<DecisionsStatus>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function push(status: DecisionsStatus): void {
  act(() => {
    for (const listener of [...listeners]) listener(status);
  });
}

beforeEach(() => {
  listeners.clear();
  getStatus.mockReset();
  setEnabled.mockReset();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: { getStatus, setEnabled },
      events: {
        on: (name: string, listener: Listener) => {
          if (name !== "decisions:status-changed") return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("useDecisions", () => {
  it("follows pushed status, and stops listening once unmounted", async () => {
    getStatus.mockResolvedValue({ state: "connecting", revision: 1 });
    const { result, unmount } = renderHook(() => useDecisions());
    await act(async () => {});
    expect(result.current.status).toEqual({ state: "connecting", revision: 1 });

    push({ state: "reconnecting", nextAttemptAt: 5_000, revision: 2 });
    expect(result.current.status).toEqual({
      state: "reconnecting",
      nextAttemptAt: 5_000,
      revision: 2,
    });

    unmount();
    expect(listeners.size).toBe(0);
  });

  it("keeps a push over a read that lands after it with an older revision", async () => {
    const read = deferred<DecisionsStatus>();
    getStatus.mockReturnValue(read.promise);
    const { result } = renderHook(() => useDecisions());

    push({ state: "connected", revision: 4 });
    await act(async () => {
      read.resolve({ state: "connecting", revision: 3 });
      await read.promise;
    });

    expect(result.current.status).toEqual({ state: "connected", revision: 4 });
  });

  it("keeps a push over an answer to a change that was read before it", async () => {
    getStatus.mockResolvedValue({ state: "off", revision: 1 });
    const answer = deferred<DecisionsStatus>();
    setEnabled.mockReturnValue(answer.promise);
    const { result } = renderHook(() => useDecisions());
    await act(async () => {});

    let saving!: Promise<void>;
    act(() => {
      saving = result.current.setEnabled({ enabled: true });
    });
    push({ state: "connected", revision: 6 });
    await act(async () => {
      answer.resolve({ state: "not-connected", revision: 5 });
      await saving;
    });

    expect(result.current.status).toEqual({ state: "connected", revision: 6 });
  });

  it("takes a status with no revision before anything newer has been seen", async () => {
    getStatus.mockResolvedValue({ state: "off" });
    const { result } = renderHook(() => useDecisions());
    await act(async () => {});
    expect(result.current.status).toEqual({ state: "off" });

    push({ state: "not-connected", revision: 1 });
    expect(result.current.status?.state).toBe("not-connected");
  });
});

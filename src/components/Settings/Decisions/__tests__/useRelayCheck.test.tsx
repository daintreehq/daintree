// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { DecisionsRelayCheck } from "@shared/types/decisions";
import { useRelayCheck } from "../useRelayCheck";

const checkRelay = vi.fn<(url: string) => Promise<DecisionsRelayCheck>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const A: DecisionsRelayCheck = {
  result: "unreachable",
  origin: "https://a.example.workers.dev",
  endpoint: "health",
  reason: "dns",
};
const B: DecisionsRelayCheck = {
  result: "unreachable",
  origin: "https://b.example.workers.dev",
  endpoint: "health",
  reason: "refused",
};

describe("useRelayCheck", () => {
  beforeEach(() => {
    checkRelay.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { checkRelay } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("keeps the newer run's observation when an older reply lands after it", async () => {
    const older = deferred<DecisionsRelayCheck>();
    const newer = deferred<DecisionsRelayCheck>();
    checkRelay.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useRelayCheck());

    act(() => result.current.run("a"));
    act(() => result.current.run("b"));
    await act(async () => newer.resolve(B));
    await act(async () => older.resolve(A));

    expect(result.current).toMatchObject({ check: B, checkedUrl: "b", checking: false });
  });

  it("never lets an older failure replace a newer observation or loading state", async () => {
    const older = deferred<DecisionsRelayCheck>();
    const newer = deferred<DecisionsRelayCheck>();
    checkRelay.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useRelayCheck());

    act(() => result.current.run("a"));
    act(() => result.current.run("b"));
    await act(async () => older.reject(new Error("cancelled")));

    expect(result.current).toMatchObject({ checking: true, error: null, check: null });
    await act(async () => newer.resolve(B));
    expect(result.current).toMatchObject({ checking: false, error: null, check: B });
  });

  it("drops a reply or a failure still out once reset", async () => {
    const reply = deferred<DecisionsRelayCheck>();
    const failure = deferred<DecisionsRelayCheck>();
    checkRelay.mockReturnValueOnce(reply.promise).mockReturnValueOnce(failure.promise);
    const { result } = renderHook(() => useRelayCheck());

    act(() => result.current.run("a"));
    act(() => result.current.reset());
    await act(async () => reply.resolve(A));
    expect(result.current).toMatchObject({ check: null, checking: false });

    act(() => result.current.run("b"));
    act(() => result.current.reset());
    await act(async () => failure.reject(new Error("refused")));
    expect(result.current).toMatchObject({ check: null, checking: false, error: null });
  });

  it("says why main couldn't check, and clears it on the next run", async () => {
    checkRelay.mockRejectedValueOnce(new Error("Turn on Decisions to check a relay"));
    checkRelay.mockResolvedValueOnce(A);
    const { result } = renderHook(() => useRelayCheck());

    await act(async () => result.current.run("a"));
    expect(result.current.error).toContain("Turn on Decisions to check a relay");

    await act(async () => result.current.run("a"));
    expect(result.current).toMatchObject({ error: null, check: A });
  });

  it("shows a reply under StrictMode's mount, unmount and mount again", async () => {
    checkRelay.mockResolvedValueOnce(A);
    const { result } = renderHook(() => useRelayCheck(), { wrapper: StrictMode });

    await act(async () => result.current.run("a"));

    expect(result.current).toMatchObject({ check: A, checking: false });
  });
});

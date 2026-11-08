// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ClaudeUsageAccount } from "@shared/types/ipc/agentQuota";

const readUsage = vi.hoisted(() => vi.fn<() => Promise<ClaudeUsageAccount[]>>());
vi.mock("@/clients/claudeClient", () => ({ claudeClient: { readUsage: () => readUsage() } }));

import { useClaudeUsage } from "../useClaudeUsage";

const MINUTE = 60_000;

const account = (key: string): ClaudeUsageAccount => ({
  key,
  kind: "default",
  accountNames: [],
  readings: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useClaudeUsage (#16370)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readUsage.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads nothing while disabled", async () => {
    const { result } = renderHook(() => useClaudeUsage(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE * 2);
    });
    expect(readUsage).not.toHaveBeenCalled();
    expect(result.current.accounts).toBeNull();
  });

  it("reads on mount and again once a minute has passed", async () => {
    readUsage.mockResolvedValueOnce([]).mockResolvedValueOnce([account("a")]);
    const { result } = renderHook(() => useClaudeUsage(true));
    await act(async () => {});
    expect(result.current.accounts).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE - 1);
    });
    expect(readUsage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(result.current.accounts).toEqual([account("a")]);
  });

  it("lets a read slower than the interval land instead of starting another", async () => {
    const slow = deferred<ClaudeUsageAccount[]>();
    readUsage.mockReturnValueOnce(slow.promise).mockResolvedValue([account("later")]);
    const { result } = renderHook(() => useClaudeUsage(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE * 3);
    });
    expect(readUsage).toHaveBeenCalledTimes(1);

    await act(async () => slow.resolve([account("slow")]));
    expect(result.current.accounts).toEqual([account("slow")]);
  });

  it("keeps what it showed when a later read fails, and says it failed", async () => {
    readUsage.mockResolvedValueOnce([account("a")]).mockRejectedValueOnce(new Error("ipc gone"));
    const { result } = renderHook(() => useClaudeUsage(true));
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE);
    });
    expect(result.current.accounts).toEqual([account("a")]);
    expect(result.current.failed).toBe(true);

    readUsage.mockResolvedValueOnce([account("b")]);
    await act(async () => result.current.refresh());
    expect(result.current.accounts).toEqual([account("b")]);
    expect(result.current.failed).toBe(false);
  });

  it("lets Retry overtake a read in flight, and ignores how the overtaken one ends", async () => {
    const first = deferred<ClaudeUsageAccount[]>();
    readUsage.mockReturnValueOnce(first.promise).mockResolvedValueOnce([account("new")]);
    const { result } = renderHook(() => useClaudeUsage(true));

    await act(async () => result.current.refresh());
    await act(async () => first.reject(new Error("late failure")));

    expect(result.current.accounts).toEqual([account("new")]);
    expect(result.current.failed).toBe(false);
  });

  it("drops a read that fails after it was turned off and on again", async () => {
    const stale = deferred<ClaudeUsageAccount[]>();
    readUsage.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([account("fresh")]);
    const { result, rerender } = renderHook(({ on }) => useClaudeUsage(on), {
      initialProps: { on: true },
    });

    rerender({ on: false });
    rerender({ on: true });
    await act(async () => {});
    await act(async () => stale.reject(new Error("from the old mount")));

    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(result.current.accounts).toEqual([account("fresh")]);
    expect(result.current.failed).toBe(false);
  });

  it("stops reading once unmounted", async () => {
    readUsage.mockResolvedValue([]);
    const { unmount } = renderHook(() => useClaudeUsage(true));
    await act(async () => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE * 3);
    });
    expect(readUsage).toHaveBeenCalledTimes(1);
  });
});

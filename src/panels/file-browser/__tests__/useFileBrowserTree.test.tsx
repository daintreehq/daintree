// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { FileTreeNode } from "@shared/types";
import type { FileBrowserListDirectoryPayload } from "@shared/types/ipc/fileBrowser";
import { useFileBrowserTree } from "../useFileBrowserTree";

const listDirectory =
  vi.fn<(payload: FileBrowserListDirectoryPayload) => Promise<FileTreeNode[]>>();

vi.mock("@/clients/fileBrowserClient", () => ({
  fileBrowserClient: {
    listDirectory: (payload: FileBrowserListDirectoryPayload) => listDirectory(payload),
  },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

function dir(path: string): FileTreeNode {
  return { name: path.split("/").pop()!, path, isDirectory: true };
}

function file(path: string): FileTreeNode {
  return { name: path.split("/").pop()!, path, isDirectory: false };
}

/** A deferred promise so a listing can be held open mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useFileBrowserTree", () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  it("lists the root once on mount and exposes its entries as rows", async () => {
    listDirectory.mockResolvedValue([dir("src"), file("README.md")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: [],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.rows.map((row) => row.path)).toEqual(["src", "README.md"]);
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it("omits dirPath entirely for the root rather than sending an empty string", async () => {
    listDirectory.mockResolvedValue([]);

    renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: [],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    expect(listDirectory.mock.calls[0]?.[0]).toEqual({ worktreeId: "wt-1" });
  });

  it("makes no request at all without a worktree", () => {
    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: undefined,
        expandedPaths: [],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    expect(listDirectory).not.toHaveBeenCalled();
    // Without a worktree there is nothing to wait for, so the panel must not
    // sit on a skeleton forever.
    expect(result.current.isInitialLoading).toBe(false);
  });

  it("fetches a directory when it becomes expanded", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/app.ts")] : [dir("src")]
    );

    const { result, rerender } = renderHook(
      (props: { expandedPaths: string[] }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: props.expandedPaths,
          showIgnored: false,
          changeTick: undefined,
        }),
      { initialProps: { expandedPaths: [] as string[] } }
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    rerender({ expandedPaths: ["src"] });

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src", "src/app.ts"])
    );
  });

  it("does not request a persisted expansion whose parent is still collapsed", async () => {
    listDirectory.mockResolvedValue([dir("src")]);

    renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        // A restored panel remembers `src/lib`, but `src` is not expanded, so
        // no row for `src/lib` can exist yet.
        expandedPaths: ["src/lib"],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    expect(listDirectory.mock.calls.map((call) => call[0].dirPath)).toEqual([undefined]);
  });

  it("re-lists the root and every expanded directory when the change tick moves", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/app.ts")] : [dir("src")]
    );

    const { result, rerender } = renderHook(
      (props: { changeTick: number | undefined }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: ["src"],
          showIgnored: false,
          changeTick: props.changeTick,
        }),
      { initialProps: { changeTick: 1 as number | undefined } }
    );

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const callsBeforeTick = listDirectory.mock.calls.length;

    rerender({ changeTick: 2 });

    await waitFor(() => expect(listDirectory.mock.calls.length).toBe(callsBeforeTick + 2));
    expect(
      listDirectory.mock.calls
        .slice(-2)
        .map((call) => call[0].dirPath)
        .sort()
    ).toEqual(["src", undefined]);
  });

  it("does not re-fetch when the change tick is unchanged across a rerender", async () => {
    listDirectory.mockResolvedValue([file("a.ts")]);

    const { result, rerender } = renderHook(
      (props: { changeTick: number }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: props.changeTick,
        }),
      { initialProps: { changeTick: 7 } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    const calls = listDirectory.mock.calls.length;

    rerender({ changeTick: 7 });
    rerender({ changeTick: 7 });

    expect(listDirectory.mock.calls.length).toBe(calls);
  });

  it("does not stack a second request for a directory already in flight", async () => {
    const pending = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValue(pending.promise);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: [],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.ensureLoaded("");
      result.current.ensureLoaded("");
    });

    expect(listDirectory).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve([]);
    });
  });

  it("passes includeIgnored and drops the cached listings when the toggle flips", async () => {
    listDirectory.mockResolvedValue([file("a.ts")]);

    const { result, rerender } = renderHook(
      (props: { showIgnored: boolean }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: props.showIgnored,
          changeTick: undefined,
        }),
      { initialProps: { showIgnored: false } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(listDirectory.mock.calls[0]?.[0].includeIgnored).toBeUndefined();

    rerender({ showIgnored: true });

    // The flag changes what every listing contains, so a partial refresh would
    // show ignored entries in some folders and hide them in others.
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
    expect(listDirectory.mock.calls[1]?.[0].includeIgnored).toBe(true);
  });

  it("leaves the tree usable when a single directory listing fails", async () => {
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") throw new Error("permission denied");
      return [dir("src"), file("README.md")];
    });

    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: ["src"],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));

    // One unreadable folder must not take the whole panel down.
    expect(result.current.rootError).toBeNull();
    expect(result.current.rows.map((row) => row.path)).toEqual(["src", "README.md"]);
  });

  it("re-runs a change tick that arrived while the initial listing was still in flight", async () => {
    const slowRoot = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slowRoot.promise);

    const { result, rerender } = renderHook(
      (props: { changeTick: number }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: props.changeTick,
        }),
      { initialProps: { changeTick: 1 } }
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));

    // A file changes while the very first listing is still reading the disk.
    rerender({ changeTick: 2 });

    listDirectory.mockResolvedValue([file("written-by-agent.ts")]);
    await act(async () => {
      slowRoot.resolve([]);
    });

    // The tick must not be consumed by a response that predates it — otherwise
    // the tree shows an empty worktree forever.
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["written-by-agent.ts"])
    );
  });

  it("re-runs a change tick that collided with an in-flight refresh", async () => {
    listDirectory.mockResolvedValue([file("v1.ts")]);

    const { result, rerender } = renderHook(
      (props: { changeTick: number }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: props.changeTick,
        }),
      { initialProps: { changeTick: 1 } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    const slowRefresh = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slowRefresh.promise);
    rerender({ changeTick: 2 });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));

    // Second change lands while the first refresh is still reading.
    rerender({ changeTick: 3 });

    listDirectory.mockResolvedValue([file("v3.ts")]);
    await act(async () => {
      slowRefresh.resolve([file("v2.ts")]);
    });

    await waitFor(() => expect(result.current.rows.map((row) => row.path)).toEqual(["v3.ts"]));
  });

  it("never exceeds its concurrency ceiling when a wide tree is restored", async () => {
    const rootEntries = Array.from({ length: 60 }, (_, index) => dir(`d${index}`));
    let inFlight = 0;
    let peakInFlight = 0;
    const releases: Array<() => void> = [];

    listDirectory.mockImplementation((payload) => {
      if (payload.dirPath === undefined) return Promise.resolve(rootEntries);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const pending = deferred<FileTreeNode[]>();
      releases.push(() => {
        inFlight -= 1;
        pending.resolve([]);
      });
      return pending.promise;
    });

    renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: rootEntries.map((node) => node.path),
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(inFlight).toBeGreaterThan(0));

    // Firing all 60 at once would blow the IPC channel's rate limit and hand the
    // workspace host a git subprocess per request.
    expect(peakInFlight).toBeLessThanOrEqual(6);

    await act(async () => {
      for (const release of releases.splice(0)) release();
    });
  });

  it("does not cache a directory whose listing arrives after it was collapsed", async () => {
    const slowChild = deferred<FileTreeNode[]>();
    listDirectory.mockImplementation((payload) =>
      payload.dirPath === "src" ? slowChild.promise : Promise.resolve([dir("src")])
    );

    const { result, rerender } = renderHook(
      (props: { expandedPaths: string[] }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: props.expandedPaths,
          showIgnored: false,
          changeTick: undefined,
        }),
      { initialProps: { expandedPaths: ["src"] as string[] } }
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));

    rerender({ expandedPaths: [] });
    await act(async () => {
      slowChild.resolve([file("src/stale.ts")]);
    });

    // Re-expanding must re-read rather than replay the listing captured before
    // the collapse.
    const callsAfterCollapse = listDirectory.mock.calls.length;
    listDirectory.mockResolvedValue([file("src/fresh.ts")]);
    rerender({ expandedPaths: ["src"] });

    await waitFor(() =>
      expect(listDirectory.mock.calls.length).toBeGreaterThan(callsAfterCollapse)
    );
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src", "src/fresh.ts"])
    );
  });

  it("stops pumping its queue once the panel unmounts", async () => {
    const rootEntries = Array.from({ length: 30 }, (_, index) => dir(`d${index}`));
    const releases: Array<() => void> = [];
    listDirectory.mockImplementation((payload) => {
      if (payload.dirPath === undefined) return Promise.resolve(rootEntries);
      const pending = deferred<FileTreeNode[]>();
      releases.push(() => pending.resolve([]));
      return pending.promise;
    });

    const { unmount } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: rootEntries.map((node) => node.path),
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(releases.length).toBeGreaterThan(0));
    unmount();

    const callsAtUnmount = listDirectory.mock.calls.length;
    await act(async () => {
      for (const release of releases.splice(0)) release();
    });

    // A closed panel must not keep spending the channel's shared budget on a
    // tree nobody is looking at.
    expect(listDirectory.mock.calls.length).toBe(callsAtUnmount);
  });

  it("drops a slow listing from a previous worktree instead of showing it in the new one", async () => {
    const slowFirst = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slowFirst.promise);

    const { result, rerender } = renderHook(
      (props: { worktreeId: string }) =>
        useFileBrowserTree({
          worktreeId: props.worktreeId,
          expandedPaths: [],
          showIgnored: false,
          changeTick: undefined,
        }),
      { initialProps: { worktreeId: "wt-1" } }
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));

    listDirectory.mockResolvedValue([file("second.ts")]);
    rerender({ worktreeId: "wt-2" });

    await waitFor(() => expect(result.current.rows.map((row) => row.path)).toEqual(["second.ts"]));

    await act(async () => {
      slowFirst.resolve([file("first.ts")]);
    });

    expect(result.current.rows.map((row) => row.path)).toEqual(["second.ts"]);
  });

  it("lists the browse root as its first request and renders from it", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src/panels" ? [file("src/panels/registry.tsx")] : [dir("src")]
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: [],
        showIgnored: false,
        rootPath: "src/panels",
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(listDirectory.mock.calls[0]?.[0]).toEqual({ worktreeId: "wt-1", dirPath: "src/panels" });
    expect(result.current.rows.map((row) => row.path)).toEqual(["src/panels/registry.tsx"]);
  });

  it("resets and re-lists when the browse root changes", async () => {
    const rootedListing = deferred<FileTreeNode[]>();
    listDirectory.mockImplementation((payload) =>
      payload.dirPath === "src"
        ? rootedListing.promise
        : Promise.resolve([dir("src"), file("README.md")])
    );

    const { result, rerender } = renderHook(
      (props: { rootPath: string }) =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          rootPath: props.rootPath,
          changeTick: undefined,
        }),
      { initialProps: { rootPath: "" } }
    );

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src", "README.md"])
    );

    rerender({ rootPath: "src" });

    // The old identity's rows clear immediately — while the new root's listing
    // is still in flight, stale rows must not remain clickable.
    await waitFor(() => expect(result.current.rows).toEqual([]));
    expect(result.current.isInitialLoading).toBe(true);

    await act(async () => {
      rootedListing.resolve([file("src/index.ts")]);
    });
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src/index.ts"])
    );

    rerender({ rootPath: "" });

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src", "README.md"])
    );
  });

  it("ignores a persisted expansion that lies outside the browse root", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [dir("src/lib")] : [file("other/one.ts")]
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        // `other` survives in panel data from before the re-root; requesting it
        // would spend the channel budget on rows that can never render.
        expandedPaths: ["other"],
        showIgnored: false,
        rootPath: "src",
        changeTick: undefined,
      })
    );

    // Settle the root listing first: the expansion-driven fetch effect only
    // runs once the root has landed, so asserting before that would pass even
    // if the effect later requested the outside-root directory.
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(listDirectory.mock.calls.map((call) => call[0]?.dirPath)).toEqual(["src"]);
  });

  // Switching back to an idle project re-fetches the tree while the workspace
  // host is still being repointed to this window, so the first root listing can
  // throw a transient `Worktree not found`. These tests pin the silent-retry
  // grace window: only a failure that persists across the whole backoff paints
  // the banner. Fake timers are scoped here so the real-timer tests above are
  // untouched; `waitFor` is deliberately avoided while they're active (its
  // polling timer would need advancing and can hang).
  describe("root retry grace window", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Flush the mocked-promise microtasks the hook awaits, without advancing any
    // timer. Promises aren't faked, so this settles the pending listDirectory.
    async function flush() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("keeps a single transient root failure invisible and self-heals on retry", async () => {
      // Mount fails with the switch-back race error; the retry succeeds.
      listDirectory
        .mockRejectedValueOnce(new Error("Worktree not found: wt-1"))
        .mockResolvedValue([file("a.ts")]);

      const { result } = renderHook(() =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: undefined,
        })
      );

      await flush();
      // The transient failure must never surface: still loading, no banner.
      expect(result.current.rootError).toBeNull();
      expect(result.current.isInitialLoading).toBe(true);

      // The first (150ms) retry succeeds and the tree renders — error never seen.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.isInitialLoading).toBe(false);
      expect(result.current.rows.map((row) => row.path)).toEqual(["a.ts"]);
    });

    it("surfaces a persistent root failure only after the retry budget is spent, then clears on a successful manual retry", async () => {
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { result } = renderHook(() =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: undefined,
        })
      );

      // Initial failure is silent.
      await flush();
      expect(result.current.rootError).toBeNull();
      expect(result.current.isInitialLoading).toBe(true);

      // First retry (150ms) also fails — still silent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.isInitialLoading).toBe(true);

      // Second retry (400ms) fails and exhausts the budget — now it surfaces.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(result.current.rootError).toContain("worktree is gone");
      expect(result.current.isInitialLoading).toBe(false);

      // A manual retry that succeeds clears the error and populates rows, and
      // resetting the budget lets a later failure enter grace again.
      listDirectory.mockResolvedValue([file("a.ts")]);
      await act(async () => {
        result.current.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.rows.map((row) => row.path)).toEqual(["a.ts"]);
    });

    it("does not surface a root error until the retry budget is exhausted across a longer failure streak", async () => {
      // Fails on the initial request and both retries, then would succeed — but
      // the budget is only two retries, so the third failure surfaces the error.
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { result } = renderHook(() =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: undefined,
        })
      );

      await flush();
      const callsAfterMount = listDirectory.mock.calls.length;
      expect(callsAfterMount).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(listDirectory.mock.calls.length).toBe(2);
      expect(result.current.rootError).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // Three attempts total (mount + two retries), then the banner.
      expect(listDirectory.mock.calls.length).toBe(3);
      expect(result.current.rootError).toContain("worktree is gone");
    });

    it("cancels a scheduled root retry on unmount so it never fires", async () => {
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { unmount } = renderHook(() =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: undefined,
        })
      );

      await flush();
      const callsAtUnmount = listDirectory.mock.calls.length;

      unmount();

      // Advancing well past every backoff must not resurrect the retry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(listDirectory.mock.calls.length).toBe(callsAtUnmount);
    });

    it("bails on the fire path when the retry callback runs after unmount", async () => {
      // Capture the scheduled callback so we can invoke it manually — simulating
      // the event loop having dequeued it before clearTimeout could cancel it.
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { unmount } = renderHook(() =>
        useFileBrowserTree({
          worktreeId: "wt-1",
          expandedPaths: [],
          showIgnored: false,
          changeTick: undefined,
        })
      );

      await flush();
      const scheduled = timeoutSpy.mock.calls.find(([, delay]) => delay === 150);
      expect(scheduled).toBeDefined();
      const retryCallback = scheduled![0] as () => void;

      const callsBefore = listDirectory.mock.calls.length;
      unmount();
      // The on-fire generation/disposed guard — not clearTimeout — must refuse
      // to issue a request here.
      act(() => {
        retryCallback();
      });
      expect(listDirectory.mock.calls.length).toBe(callsBefore);
    });

    it("drops an old identity's pending retry and gives the new identity a fresh budget", async () => {
      listDirectory.mockImplementation(async (payload) => {
        throw new Error(`Worktree not found: ${payload.worktreeId}`);
      });

      const { result, rerender } = renderHook(
        (props: { worktreeId: string }) =>
          useFileBrowserTree({
            worktreeId: props.worktreeId,
            expandedPaths: [],
            showIgnored: false,
            changeTick: undefined,
          }),
        { initialProps: { worktreeId: "wt-1" } }
      );

      // wt-1 fails on mount and schedules a retry we're about to strand.
      await flush();

      // Switch identity before wt-1's retry can fire; wt-2 fails once then heals.
      listDirectory.mockReset();
      listDirectory
        .mockRejectedValueOnce(new Error("Worktree not found: wt-2"))
        .mockResolvedValue([file("b.ts")]);
      rerender({ worktreeId: "wt-2" });
      await flush();

      // wt-2's grace window is fresh (index 0), so its 150ms retry succeeds.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.rows.map((row) => row.path)).toEqual(["b.ts"]);

      // Advancing past wt-1's old backoff must not resurrect it — no wt-1 call
      // was issued after the switch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(listDirectory.mock.calls.some((call) => call[0].worktreeId === "wt-1")).toBe(false);
    });
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { FileTreeNode } from "@shared/types";
import type { FileBrowserListDirectoryPayload } from "@shared/types/ipc/fileBrowser";
import { useFileBrowserTree } from "../useFileBrowserTree";
import type { FileBrowserSortOrder, FileBrowserSource } from "../fileBrowserTree";

const listDirectory =
  vi.fn<(payload: FileBrowserListDirectoryPayload) => Promise<FileTreeNode[]>>();

vi.mock("@/clients/fileBrowserClient", () => ({
  fileBrowserClient: {
    listDirectory: (payload: FileBrowserListDirectoryPayload) => listDirectory(payload),
  },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

function wtSource(worktreeId: string): FileBrowserSource {
  return { kind: "worktree", worktreeId, basePath: `/repo/${worktreeId}` };
}

function wsSource(basePath = "/scratches/one"): FileBrowserSource {
  return { kind: "workspace", basePath };
}

function dir(path: string): FileTreeNode {
  return { name: path.split("/").pop()!, path, isDirectory: true };
}

function file(path: string): FileTreeNode {
  return { name: path.split("/").pop()!, path, isDirectory: false };
}

/**
 * Long enough for any effect-driven re-request to have been enqueued and
 * pumped, so "no further calls after this" is a real statement about the
 * implementation rather than about the test's timing.
 */
const SETTLE_MS = 50;

/** Give pending effects and their queued fetches a chance to fire. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

/**
 * Declared as a typed const rather than inline: `renderHook` infers its prop
 * type from `initialProps`, so inline literals would narrow `sort` to exactly
 * the initial value and reject the re-sort the test exists to perform.
 */
const INITIAL_SORT_PROPS: { sort: FileBrowserSortOrder } = {
  sort: { key: "name", direction: "asc" },
};

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
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    expect(listDirectory.mock.calls[0]?.[0]).toEqual({ worktreeId: "wt-1" });
  });

  it("makes no request at all without a worktree", () => {
    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: null,
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
          source: wtSource("wt-1"),
          expandedPaths: props.expandedPaths,
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        // A restored panel remembers `src/lib`, but `src` is not expanded, so
        // no row for `src/lib` can exist yet.
        expandedPaths: ["src/lib"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
          source: wtSource("wt-1"),
          expandedPaths: ["src"],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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

  it("never sends a server-side filter flag — every listing request is raw", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/app.ts")] : [dir("src")]
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: ["src"],
        // Visibility is on, yet the request must stay raw: filtering is now the
        // client's job, so no listing may carry an includeIgnored-style flag.
        hideDotfiles: true,
        alwaysHiddenPatterns: [".DS_Store"],
        changeTick: undefined,
      })
    );

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src", "src/app.ts"])
    );

    for (const [payload] of listDirectory.mock.calls) {
      expect(Object.keys(payload)).not.toContain("includeIgnored");
    }
  });

  it("shows dot-prefixed entries by default and hides them once hideDotfiles is on", async () => {
    listDirectory.mockResolvedValue([file(".env"), dir("src"), file("README.md")]);

    const { result, rerender } = renderHook(
      (props: { hideDotfiles: boolean }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: props.hideDotfiles,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        }),
      { initialProps: { hideDotfiles: false } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.rows.map((row) => row.path)).toEqual([".env", "src", "README.md"]);

    rerender({ hideDotfiles: true });

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["src", "README.md"])
    );
  });

  it("hides an always-hidden junk entry even while dotfiles are shown", async () => {
    listDirectory.mockResolvedValue([file(".DS_Store"), file(".env"), file("README.md")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [".DS_Store"],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    // Dotfiles are shown, so `.env` survives; the junk list still removes
    // `.DS_Store` regardless of the dotfile toggle.
    expect(result.current.rows.map((row) => row.path)).toEqual([".env", "README.md"]);
  });

  it("re-derives rows on a dotfile toggle without issuing a new listing request", async () => {
    listDirectory.mockResolvedValue([file(".env"), file("README.md")]);

    const { result, rerender } = renderHook(
      (props: { hideDotfiles: boolean }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: props.hideDotfiles,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        }),
      { initialProps: { hideDotfiles: false } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    const callsAfterInitialLoad = listDirectory.mock.calls.length;
    expect(result.current.rows.map((row) => row.path)).toEqual([".env", "README.md"]);

    rerender({ hideDotfiles: true });
    await waitFor(() => expect(result.current.rows.map((row) => row.path)).toEqual(["README.md"]));

    rerender({ hideDotfiles: false });
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual([".env", "README.md"])
    );

    // The regression guard for the "filter at derivation, not refetch" design:
    // flipping visibility re-runs the row memo but must not drop the listing
    // cache or spend another IPC call.
    expect(listDirectory.mock.calls.length).toBe(callsAfterInitialLoad);
  });

  it("reports hidden dotfiles when a non-junk dot entry sits at the root", async () => {
    listDirectory.mockResolvedValue([file(".env"), file("README.md")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        // Independent of the toggle's own state: even with dotfiles hidden, the
        // affordance needs to know something is there to reveal.
        hideDotfiles: true,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.hasHiddenDotfiles).toBe(true);
  });

  it("reports no hidden dotfiles when the only dot entry is junk-listed", async () => {
    listDirectory.mockResolvedValue([file(".DS_Store"), file("README.md")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: true,
        alwaysHiddenPatterns: [".DS_Store"],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    // The junk list already hides `.DS_Store`, so turning the dotfile toggle off
    // would reveal nothing — the affordance must stay quiet.
    expect(result.current.hasHiddenDotfiles).toBe(false);
  });

  it("leaves the tree usable when a single directory listing fails", async () => {
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") throw new Error("permission denied");
      return [dir("src"), file("README.md")];
    });

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: ["src"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        expandedPaths: rootEntries.map((node) => node.path),
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
          source: wtSource("wt-1"),
          expandedPaths: props.expandedPaths,
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        expandedPaths: rootEntries.map((node) => node.path),
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
          source: wtSource(props.worktreeId),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        rootPath: "src/panels",
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(listDirectory.mock.calls[0]?.[0]).toEqual({
      worktreeId: "wt-1",
      dirPath: "src/panels",
    });
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
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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
        source: wtSource("wt-1"),
        // `other` survives in panel data from before the re-root; requesting it
        // would spend the channel budget on rows that can never render.
        expandedPaths: ["other"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
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
      // Restore spies BEFORE the clock: `restoreAllMocks` reinstalls setTimeout's
      // captured original, which — if the fake clock were already uninstalled —
      // would be the fake timer, leaking it into the next file and hanging it.
      vi.restoreAllMocks();
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
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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

    it("surfaces a persistent root failure only after the whole retry budget is spent, at the exact backoff boundaries", async () => {
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { result } = renderHook(() =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        })
      );

      // Initial failure is silent — one attempt so far, skeleton still up.
      await flush();
      expect(listDirectory).toHaveBeenCalledTimes(1);
      expect(result.current.rootError).toBeNull();
      expect(result.current.isInitialLoading).toBe(true);

      // Retry 1 fires at exactly t=150, not a millisecond before (a shorter delay
      // would fire at 149 and this would catch it).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(149);
      });
      expect(listDirectory).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(listDirectory).toHaveBeenCalledTimes(2);
      expect(result.current.rootError).toBeNull();

      // Retry 2 fires at t=550 (delay 400 after retry 1), not before.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(399);
      });
      expect(listDirectory).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(listDirectory).toHaveBeenCalledTimes(3);
      expect(result.current.rootError).toBeNull();

      // Retry 3 fires at t=1350 (delay 800) and exhausts the budget — only now
      // does the banner appear.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(799);
      });
      expect(listDirectory).toHaveBeenCalledTimes(3);
      expect(result.current.rootError).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(listDirectory).toHaveBeenCalledTimes(4);
      expect(result.current.rootError).toContain("worktree is gone");
      expect(result.current.isInitialLoading).toBe(false);
    });

    it("resets the budget on a successful retry so a later failure re-enters the grace window", async () => {
      // Fail the whole initial streak so the banner surfaces, then heal manually.
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { result } = renderHook(() =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        })
      );

      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
        await vi.advanceTimersByTimeAsync(400);
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(result.current.rootError).toContain("worktree is gone");

      // A manual refresh succeeds: error clears, rows populate, budget resets.
      listDirectory.mockResolvedValue([file("a.ts")]);
      await act(async () => {
        result.current.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.rows.map((row) => row.path)).toEqual(["a.ts"]);

      // A LATER failure must re-enter grace (silent) rather than surface at once —
      // which only holds if success reset nextDelayIndex to 0.
      listDirectory.mockReset();
      listDirectory.mockRejectedValueOnce(new Error("flap")).mockResolvedValue([file("b.ts")]);
      await act(async () => {
        result.current.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      // Refresh failure is silent and the last good rows stay visible.
      expect(result.current.rootError).toBeNull();
      expect(result.current.rows.map((row) => row.path)).toEqual(["a.ts"]);

      // Its fresh 150ms retry succeeds and swaps in the new listing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.rows.map((row) => row.path)).toEqual(["b.ts"]);
    });

    it("cancels a scheduled root retry on unmount so it never fires", async () => {
      listDirectory.mockRejectedValue(new Error("worktree is gone"));

      const { unmount } = renderHook(() =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
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

    it("a superseded retry callback that fires late issues no request (handle guard)", async () => {
      // Capture the scheduled retry so we can invoke it manually — simulating the
      // event loop having dequeued it before clearTimeout could cancel it.
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      listDirectory.mockRejectedValueOnce(new Error("Worktree not found: wt-1"));

      const { result } = renderHook(() =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        })
      );

      await flush();
      // Exactly one 150ms timer — the root retry — so we can't grab the wrong one.
      const scheduled = timeoutSpy.mock.calls.filter(([, delay]) => delay === 150);
      expect(scheduled).toHaveLength(1);
      const staleCallback = scheduled[0]![0] as () => void;

      // Supersede that pending retry with a successful manual refresh, which
      // clears the timer (rootRetryTimerRef → null). The captured callback is now
      // stale but still references its old handle. Kept mounted and same-identity
      // so ONLY the handle guard — not the disposed/generation guards, nor
      // fetchDirectory's own disposed check — can stop it.
      listDirectory.mockResolvedValue([file("a.ts")]);
      await act(async () => {
        result.current.refresh();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.rootError).toBeNull();
      expect(result.current.rows.map((row) => row.path)).toEqual(["a.ts"]);

      const callsBefore = listDirectory.mock.calls.length;
      act(() => {
        staleCallback();
      });
      // Without the `rootRetryTimerRef.current !== handle` guard this would
      // enqueue + pump another root listing.
      expect(listDirectory.mock.calls.length).toBe(callsBefore);
    });

    it("drops an old identity's pending retry and gives the new identity a fresh budget", async () => {
      listDirectory.mockImplementation(async (payload) => {
        throw new Error(`Worktree not found: ${payload.worktreeId}`);
      });

      const { result, rerender } = renderHook(
        (props: { worktreeId: string }) =>
          useFileBrowserTree({
            source: wtSource(props.worktreeId),
            expandedPaths: [],
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
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

  it("raises isRefreshing while a manual refresh is in flight, then clears it on drain", async () => {
    listDirectory.mockResolvedValue([file("a.ts")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.isRefreshing).toBe(false);

    const slow = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slow.promise);
    act(() => {
      result.current.refresh({ manual: true });
    });
    // The re-list is still reading the disk — the toolbar icon must spin.
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => {
      slow.resolve([file("a.ts")]);
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it("leaves isRefreshing dormant for a passive change-tick refresh", async () => {
    listDirectory.mockResolvedValue([file("v1.ts")]);

    const { result, rerender } = renderHook(
      (props: { changeTick: number }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: props.changeTick,
        }),
      { initialProps: { changeTick: 1 } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    const slow = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slow.promise);
    rerender({ changeTick: 2 });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));

    // A background refresh must not spin the manual Refresh icon on every
    // filesystem change.
    expect(result.current.isRefreshing).toBe(false);
    await act(async () => {
      slow.resolve([file("v2.ts")]);
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it("leaves isRefreshing dormant for a non-manual refresh() call", async () => {
    listDirectory.mockResolvedValue([file("a.ts")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    const slow = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slow.promise);
    act(() => {
      result.current.refresh();
    });
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => {
      slow.resolve([file("a.ts")]);
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it("holds isRefreshing across a collision replay until the final drain", async () => {
    listDirectory.mockResolvedValue([file("v1.ts")]);

    const { result, rerender } = renderHook(
      (props: { changeTick: number }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: props.changeTick,
        }),
      { initialProps: { changeTick: 1 } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    // A background refresh's root re-list is held open.
    const slowBg = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(slowBg.promise);
    rerender({ changeTick: 2 });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));

    // The user presses Refresh while that re-list is still in flight. Its target
    // collides, so the actual re-run is deferred — but the spin starts now.
    act(() => {
      result.current.refresh({ manual: true });
    });
    expect(result.current.isRefreshing).toBe(true);

    // The deferred replay's listing.
    const replay = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValueOnce(replay.promise);

    // Background listing settles → the collision replay is enqueued and starts.
    // Work is still pending, so the spin must not stop here.
    await act(async () => {
      slowBg.resolve([file("v2.ts")]);
    });
    expect(result.current.isRefreshing).toBe(true);

    // The replay finally settles → the manual refresh cycle ends.
    await act(async () => {
      replay.resolve([file("v3.ts")]);
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it("clears an in-flight manual refresh's spin when the worktree switches", async () => {
    const slow = deferred<FileTreeNode[]>();
    listDirectory.mockResolvedValue([file("a.ts")]);

    const { result, rerender } = renderHook(
      (props: { worktreeId: string }) =>
        useFileBrowserTree({
          source: wtSource(props.worktreeId),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        }),
      { initialProps: { worktreeId: "wt-1" } }
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    listDirectory.mockReturnValueOnce(slow.promise);
    act(() => {
      result.current.refresh({ manual: true });
    });
    expect(result.current.isRefreshing).toBe(true);

    // Switching worktrees abandons the in-flight refresh; the spin must not
    // survive the identity reset.
    listDirectory.mockResolvedValue([file("b.ts")]);
    rerender({ worktreeId: "wt-2" });
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => {
      slow.resolve([file("a.ts")]);
    });
    expect(result.current.isRefreshing).toBe(false);
  });
});

describe("stale-while-revalidate seeding (#11367)", () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  const snapshot = {
    worktreeId: "wt-1",
    basePath: "/repo/wt-1",
    rootPath: "",
    listings: [
      {
        dirPath: "",
        nodes: [
          { name: "src", path: "src", isDirectory: true },
          { name: "README.md", path: "README.md", isDirectory: false },
        ],
      },
      {
        dirPath: "src",
        nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }],
      },
    ],
  };

  it("paints seeded rows instantly and revalidates the root plus seeded expanded directories", async () => {
    const root = deferred<FileTreeNode[]>();
    const src = deferred<FileTreeNode[]>();
    listDirectory.mockImplementation(({ dirPath }) =>
      dirPath === undefined ? root.promise : src.promise
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: ["src"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        treeSnapshot: snapshot,
      })
    );

    // The whole last-known tree is on screen before any listing resolves —
    // no skeleton, and both painted directories are already revalidating.
    expect(result.current.isInitialLoading).toBe(false);
    expect(result.current.rows.map((row) => row.path)).toEqual(["src", "src/app.ts", "README.md"]);
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory.mock.calls.map(([payload]) => payload.dirPath)).toEqual([
      undefined,
      "src",
    ]);

    // Live results replace the stale seed as they land.
    await act(async () => {
      root.resolve([dir("src"), file("CHANGED.md")]);
      src.resolve([file("src/new.ts")]);
    });
    expect(result.current.rows.map((row) => row.path)).toEqual(["src", "src/new.ts", "CHANGED.md"]);
    expect(result.current.isInitialLoading).toBe(false);
  });

  it("has the seeded rows in the very first render pass — not one loading frame later", () => {
    listDirectory.mockReturnValue(deferred<FileTreeNode[]>().promise);

    // Observed at render time, not through renderHook's result: passive
    // effects have already flushed by the time result.current is readable,
    // so an effect-only seed (one blank committed frame — the flash #11367
    // removes) would be invisible to an after-the-fact assertion.
    const renderPasses: string[][] = [];
    function Probe() {
      const { rows } = useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: ["src"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        treeSnapshot: snapshot,
      });
      renderPasses.push(rows.map((row) => row.path));
      return null;
    }
    render(<Probe />);

    expect(renderPasses[0]).toEqual(["src", "src/app.ts", "README.md"]);
  });

  it("ignores a snapshot captured under another identity and cold-starts as before", () => {
    listDirectory.mockReturnValue(deferred<FileTreeNode[]>().promise);

    const otherWorktree = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-2"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        treeSnapshot: snapshot,
      })
    );
    expect(otherWorktree.result.current.isInitialLoading).toBe(true);
    expect(otherWorktree.result.current.rows).toEqual([]);

    const otherRoot = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        rootPath: "src",
        changeTick: undefined,
        treeSnapshot: snapshot,
      })
    );
    expect(otherRoot.result.current.isInitialLoading).toBe(true);
    expect(otherRoot.result.current.rows).toEqual([]);
  });

  it("captures a structure-only snapshot of the loaded tree, and nothing before the root lands", async () => {
    const slow = deferred<FileTreeNode[]>();
    listDirectory.mockReturnValue(slow.promise);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    // Nothing worth keeping yet — a capture here must not clobber a previous
    // snapshot with an empty one.
    expect(result.current.captureSnapshot()).toBeNull();

    await act(async () => {
      slow.resolve([
        { name: "big.bin", path: "big.bin", isDirectory: false, size: 4096 },
        dir("src"),
      ]);
    });

    // Size is filesystem metadata, not structure — it must not persist.
    expect(result.current.captureSnapshot()).toEqual({
      worktreeId: "wt-1",
      basePath: "/repo/wt-1",
      rootPath: "",
      listings: [
        {
          dirPath: "",
          nodes: [
            { name: "big.bin", path: "big.bin", isDirectory: false },
            { name: "src", path: "src", isDirectory: true },
          ],
        },
      ],
    });
  });

  it("captures nothing without a worktree", () => {
    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: null,
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );
    expect(result.current.captureSnapshot()).toBeNull();
  });

  describe("root failure over a seeded tree", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    async function flush() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("keeps the seeded rows on screen when the whole retry budget fails — the error joins the tree instead of replacing it", async () => {
      listDirectory.mockRejectedValue(new Error("host still repointing"));

      const { result } = renderHook(() =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: ["src"],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          treeSnapshot: snapshot,
        })
      );

      // Seeded immediately; the failing revalidation never blanks it.
      expect(result.current.rows.length).toBeGreaterThan(0);
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
        await vi.advanceTimersByTimeAsync(400);
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(result.current.rootError).toContain("host still repointing");
      expect(result.current.isInitialLoading).toBe(false);
      expect(result.current.rows.map((row) => row.path)).toEqual([
        "src",
        "src/app.ts",
        "README.md",
      ]);
    });

    it("promotes the root retry ahead of a saturated descendant backlog", async () => {
      // A wide seeded restore: 10 expanded directories revalidate alongside
      // the root, overflowing the 6-slot concurrency ceiling so a backlog is
      // queued when the root's retry fires. The retry must jump that queue —
      // appended at the tail it would wait out hundreds of listings and gut
      // the 150/400/800ms schedule.
      const dirNames = Array.from({ length: 10 }, (_, i) => `d${i}`);
      const dirDeferreds = new Map(dirNames.map((name) => [name, deferred<FileTreeNode[]>()]));
      let rootAttempts = 0;
      listDirectory.mockImplementation(({ dirPath }) => {
        if (dirPath === undefined) {
          rootAttempts += 1;
          return rootAttempts === 1
            ? Promise.reject(new Error("transient"))
            : Promise.resolve(dirNames.map((name) => dir(name)));
        }
        return dirDeferreds.get(dirPath)!.promise;
      });

      renderHook(() =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: dirNames,
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          treeSnapshot: {
            worktreeId: "wt-1",
            basePath: "/repo/wt-1",
            rootPath: "",
            listings: [
              {
                dirPath: "",
                nodes: dirNames.map((name) => ({ name, path: name, isDirectory: true })),
              },
            ],
          },
        })
      );

      // Root + d0..d4 fill the 6 slots; the root's failure frees one, so d5
      // starts; d6..d9 remain queued when the 150ms retry fires.
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      const callsBeforeSlotFrees = listDirectory.mock.calls.length;

      // Freeing one slot must start the promoted ROOT retry, not d6.
      await act(async () => {
        dirDeferreds.get("d0")!.resolve([]);
      });
      const nextCall = listDirectory.mock.calls[callsBeforeSlotFrees];
      expect(nextCall?.[0].dirPath).toBeUndefined();
    });
  });
});

/**
 * #11482: a workspace source names no root over IPC at all — main derives it
 * from the sender's own binding, which is what keeps a renderer unable to ask
 * for a folder its view isn't bound to.
 */
describe("workspace source", () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  it("sends no worktreeId when listing a workspace root", async () => {
    listDirectory.mockResolvedValue([file("notes.md")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wsSource(),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(listDirectory.mock.calls[0]?.[0]).toEqual({});
    expect(result.current.rows.map((row) => row.path)).toEqual(["notes.md"]);
  });

  it("sends only dirPath for a nested workspace directory", async () => {
    listDirectory.mockResolvedValue([]);

    renderHook(() =>
      useFileBrowserTree({
        source: wsSource(),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        rootPath: "sub",
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    expect(listDirectory.mock.calls[0]?.[0]).toEqual({ dirPath: "sub" });
  });

  it("captures a snapshot tagged with the base and no worktree id", async () => {
    listDirectory.mockResolvedValue([file("notes.md")]);

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wsSource(),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.captureSnapshot()).toMatchObject({
      basePath: "/scratches/one",
      rootPath: "",
    });
    expect(result.current.captureSnapshot()?.worktreeId).toBeUndefined();
  });

  it("re-lists the whole tree when a workspace root moves", async () => {
    listDirectory.mockResolvedValue([]);

    const { rerender } = renderHook(
      (props: { basePath: string }) =>
        useFileBrowserTree({
          source: wsSource(props.basePath),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        }),
      { initialProps: { basePath: "/scratches/one" } }
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    // The base is the workspace's identity, so a move is a full reset — the
    // old folder's listings mean nothing to the new one.
    rerender({ basePath: "/scratches/two" });
    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
  });

  it("does not re-list on a re-render that rebuilds an equivalent source", async () => {
    listDirectory.mockResolvedValue([]);

    const { rerender } = renderHook(() =>
      useFileBrowserTree({
        // A fresh object every render, as the pane produces.
        source: wsSource(),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    // Identity is the derived key, not the object reference — otherwise every
    // render would reset the tree.
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });
});

describe("useFileBrowserTree folder listing (#11620)", () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  function renderTree(selectedPath: string | null, expandedPaths: string[] = []) {
    return renderHook(
      (props: { selectedPath: string | null; expandedPaths: string[] }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: props.expandedPaths,
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          selectedPath: props.selectedPath,
        }),
      { initialProps: { selectedPath, expandedPaths } }
    );
  }

  it("reports no listing when nothing is selected", async () => {
    listDirectory.mockResolvedValue([dir("src")]);

    const { result } = renderTree(null);

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.listingPath).toBeNull();
    expect(result.current.listingRows).toBeNull();
  });

  it("reports no listing when the selection is a file", async () => {
    listDirectory.mockResolvedValue([file("README.md")]);

    const { result } = renderTree("README.md");

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.listingPath).toBeNull();
    expect(result.current.selectedNode?.isDirectory).toBe(false);
  });

  it("fetches a selected folder that was never expanded, and lists its contents", async () => {
    // Selecting from the keyboard never expands, so nothing else would ask for
    // this folder's children.
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/a.ts")] : [dir("src")]
    );

    const { result } = renderTree("src");

    await waitFor(() => expect(result.current.listingRows).not.toBeNull());
    expect(result.current.listingPath).toBe("src");
    expect(result.current.listingRows?.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  it("reports pending until the folder's listing arrives", async () => {
    const gate = deferred<FileTreeNode[]>();
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? gate.promise : [dir("src")]
    );

    const { result } = renderTree("src");

    // Raw pending, not a gated flag — the consumer needs this apart from
    // "loaded and empty" to choose between a skeleton and an empty state.
    await waitFor(() => expect(result.current.listingStatus).toBe("pending"));
    expect(result.current.listingRows).toBeNull();

    await act(async () => {
      gate.resolve([file("src/a.ts")]);
      await gate.promise;
    });

    await waitFor(() => expect(result.current.listingStatus).toBe("ready"));
  });

  it("distinguishes an empty folder from one still loading", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [] : [dir("src")]
    );

    const { result } = renderTree("src");

    // Waits on the rows, not on `listingStatus`: status is also "ready" while
    // no folder has resolved yet, which is true on the very first render and
    // would let this pass before anything had loaded.
    await waitFor(() => expect(result.current.listingRows).toEqual([]));
    // [] not null: the folder really holds nothing, which is a different answer
    // from "not fetched yet".
    expect(result.current.listingStatus).toBe("ready");
  });

  it("reports an error instead of pending forever when the folder can't be read", async () => {
    // Per-directory failures are silent for the tree, which would otherwise
    // leave the listing on a skeleton with no way out.
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") throw new Error("EACCES");
      return [dir("src")];
    });

    const { result } = renderTree("src");

    await waitFor(() => expect(result.current.listingStatus).toBe("error"));
    expect(result.current.listingRows).toBeNull();
  });

  it("does not re-request a folder whose fetch already failed", async () => {
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") throw new Error("EACCES");
      return [dir("src")];
    });

    const { result } = renderTree("src");

    await waitFor(() => expect(result.current.listingStatus).toBe("error"));
    const afterFailure = listDirectory.mock.calls.filter((c) => c[0].dirPath === "src").length;

    // A failed path is in neither the listings map nor the in-flight set, so
    // without an explicit guard this would refire on every render.
    await settle();
    expect(listDirectory.mock.calls.filter((c) => c[0].dirPath === "src")).toHaveLength(
      afterFailure
    );
  });

  it("keeps the listed folder's contents when an unrelated folder collapses", async () => {
    // The prune drops collapsed subtrees; the folder on screen is being read
    // right now, so it is not the stale unused entry that prune exists for.
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") return [file("src/a.ts")];
      if (payload.dirPath === "docs") return [file("docs/b.md")];
      return [dir("src"), dir("docs")];
    });

    const { result, rerender } = renderTree("src", ["docs"]);

    await waitFor(() => expect(result.current.listingRows).not.toBeNull());

    // Collapse the unrelated folder — the listed one must survive the prune.
    rerender({ selectedPath: "src", expandedPaths: [] });

    await waitFor(() => expect(result.current.listingStatus).toBe("ready"));
    expect(result.current.listingRows?.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  it("resolves a node whose parent is not expanded in the tree", async () => {
    // The reason selection resolution moved off the rendered rows: an entry
    // picked from the folder listing has no tree row at all.
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/deep.ts")] : [dir("src")]
    );

    const { result, rerender } = renderTree("src");

    await waitFor(() => expect(result.current.listingRows).not.toBeNull());
    rerender({ selectedPath: "src/deep.ts", expandedPaths: [] });

    await waitFor(() => expect(result.current.selectedNode?.path).toBe("src/deep.ts"));
    expect(result.current.selectedNode?.isDirectory).toBe(false);
    // It is genuinely absent from the tree's rows — that is the whole point.
    expect(result.current.rows.map((r) => r.path)).not.toContain("src/deep.ts");
  });

  it("stops listing a folder the dotfile filter has just hidden", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === ".config" ? [file(".config/a.ts")] : [dir(".config")]
    );

    const { result, rerender } = renderHook(
      (props: { hideDotfiles: boolean }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: props.hideDotfiles,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          selectedPath: ".config",
        }),
      { initialProps: { hideDotfiles: false } }
    );

    await waitFor(() => expect(result.current.listingPath).toBe(".config"));

    rerender({ hideDotfiles: true });

    // The selection survives in the panel record but has no row, so it must
    // stop driving a listing the tree cannot show.
    await waitFor(() => expect(result.current.listingPath).toBeNull());
  });

  it("orders the tree and the listing by the same sort", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src"
        ? [
            { name: "a.ts", path: "src/a.ts", isDirectory: false, size: 1 },
            { name: "b.ts", path: "src/b.ts", isDirectory: false, size: 900 },
          ]
        : [dir("src")]
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: ["src"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        selectedPath: "src",
        sort: { key: "size", direction: "desc" },
      })
    );

    await waitFor(() => expect(result.current.listingRows).not.toBeNull());

    const listingOrder = result.current.listingRows?.map((r) => r.path);
    const treeOrder = result.current.rows.map((r) => r.path).filter((p) => p.startsWith("src/"));

    expect(listingOrder).toEqual(["src/b.ts", "src/a.ts"]);
    // Two columns showing the same directory in different orders would read as
    // two different folders.
    expect(treeOrder).toEqual(listingOrder);
  });

  it("reports whether the dotfile toggle is hiding anything in the listed folder", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/.env")] : [dir("src")]
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: true,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        selectedPath: "src",
      })
    );

    // Waits on the rows, not on `listingStatus`: status is also "ready" while
    // no folder is selected at all, which is true on the very first render and
    // would let this assert against a tree that had not loaded anything yet.
    await waitFor(() => expect(result.current.listingRows).toEqual([]));
    expect(result.current.listingStatus).toBe("ready");
    // Filtered-empty, not zero-data: offering "Show dotfiles" here actually helps.
    expect(result.current.listingHasHiddenDotfiles).toBe(true);
  });
});

describe("useFileBrowserTree listing recovery and revalidation (#11620)", () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  it("recovers a failed folder listing when the user refreshes", () => {
    // End to end, not just the callback wiring: fail, assert the error state,
    // then drive the same refresh the viewer's Retry runs and assert real rows.
    let failNext = true;
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") {
        if (failNext) throw new Error("EACCES");
        return [file("src/a.ts")];
      }
      return [dir("src")];
    });

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        selectedPath: "src",
      })
    );

    return waitFor(() => expect(result.current.listingStatus).toBe("error"))
      .then(() => {
        failNext = false;
        act(() => result.current.refresh({ manual: true }));
        return waitFor(() => expect(result.current.listingStatus).toBe("ready"));
      })
      .then(() => {
        expect(result.current.listingRows?.map((r) => r.path)).toEqual(["src/a.ts"]);
      });
  });

  it("does not re-request a failed expanded directory every time a sibling lands", async () => {
    // A restored tree with one unreadable directory used to re-enqueue it on
    // every listing commit, because a failed path is in neither the listings
    // map nor the in-flight set.
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "bad") throw new Error("EACCES");
      if (payload.dirPath === "a") return [file("a/1.ts")];
      if (payload.dirPath === "b") return [file("b/1.ts")];
      return [dir("bad"), dir("a"), dir("b")];
    });

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: ["bad", "a", "b"],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    await settle();

    expect(listDirectory.mock.calls.filter((c) => c[0].dirPath === "bad")).toHaveLength(1);
  });

  it("retries a failed directory after it is collapsed and re-expanded", async () => {
    // Collapsing clears the recorded failure, so the natural try-again gesture
    // works rather than being refused forever by the skip above.
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "bad") throw new Error("EACCES");
      return [dir("bad")];
    });

    const { result, rerender } = renderHook(
      (props: { expandedPaths: string[] }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: props.expandedPaths,
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        }),
      { initialProps: { expandedPaths: ["bad"] } }
    );

    await waitFor(() =>
      expect(listDirectory.mock.calls.filter((c) => c[0].dirPath === "bad")).toHaveLength(1)
    );

    rerender({ expandedPaths: [] });
    rerender({ expandedPaths: ["bad"] });

    await waitFor(() =>
      expect(listDirectory.mock.calls.filter((c) => c[0].dirPath === "bad")).toHaveLength(2)
    );
    void result;
  });

  it("re-reads a selected collapsed folder that was seeded from a snapshot", async () => {
    // The snapshot is structure-only, so its rows carry no size or mtime. If
    // the restore revalidation skipped the selected folder, the listing would
    // sit on those metadata-less rows indefinitely.
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src"
        ? [{ name: "a.ts", path: "src/a.ts", isDirectory: false, size: 42, mtimeMs: 1_700_000 }]
        : [dir("src")]
    );

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        selectedPath: "src",
        treeSnapshot: {
          worktreeId: "wt-1",
          basePath: "/repo/wt-1",
          rootPath: "",
          listings: [
            { dirPath: "", nodes: [{ name: "src", path: "src", isDirectory: true }] },
            { dirPath: "src", nodes: [{ name: "a.ts", path: "src/a.ts", isDirectory: false }] },
          ],
        },
      })
    );

    // Seeded rows paint immediately with no metadata...
    await waitFor(() => expect(result.current.listingRows).not.toBeNull());
    // ...and the live re-read replaces them with real size/mtime.
    await waitFor(() => expect(result.current.listingRows?.[0]?.size).toBe(42));
    expect(result.current.listingRows?.[0]?.mtimeMs).toBe(1_700_000);
  });

  it("keeps a selected file's parent listing when the folder stops being listed", async () => {
    // Selecting a file out of a folder listing flips that folder from "being
    // listed" to "merely the parent". Dropping it there would forget the file's
    // kind on the very click that selected it.
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? [file("src/a.ts")] : [dir("src")]
    );

    const { result, rerender } = renderHook(
      (props: { selectedPath: string }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          selectedPath: props.selectedPath,
        }),
      { initialProps: { selectedPath: "src" } }
    );

    await waitFor(() => expect(result.current.listingRows).not.toBeNull());
    rerender({ selectedPath: "src/a.ts" });

    await waitFor(() => expect(result.current.listingPath).toBeNull());
    // The kind still resolves, which is what keeps the viewer on the file.
    expect(result.current.selectedNode?.isDirectory).toBe(false);
  });

  it("re-orders an on-screen listing without re-fetching it", async () => {
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src"
        ? [
            { name: "a.ts", path: "src/a.ts", isDirectory: false, size: 1 },
            { name: "b.ts", path: "src/b.ts", isDirectory: false, size: 900 },
          ]
        : [dir("src")]
    );

    const { result, rerender } = renderHook(
      (props: { sort: FileBrowserSortOrder }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          selectedPath: "src",
          sort: props.sort,
        }),
      { initialProps: INITIAL_SORT_PROPS }
    );

    await waitFor(() => expect(result.current.listingRows).not.toBeNull());
    const callsBefore = listDirectory.mock.calls.length;

    rerender({ sort: { key: "size", direction: "desc" } });

    await waitFor(() =>
      expect(result.current.listingRows?.map((r) => r.name)).toEqual(["b.ts", "a.ts"])
    );
    // Sorting is a client-side reorder of cached rows — it must cost no IPC.
    expect(listDirectory.mock.calls).toHaveLength(callsBefore);
  });
});

describe("useFileBrowserTree failure recovery edge cases (#11620)", () => {
  beforeEach(() => {
    listDirectory.mockReset();
  });

  it("retries a directory whose request failed only after it was collapsed", async () => {
    // The prune's failure-clearing pass runs on collapse. A rejection that
    // lands after it would leave a failure nothing clears, and the expansion
    // effect would then refuse to re-request it — re-expanding the folder would
    // silently do nothing.
    const gate = deferred<FileTreeNode[]>();
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "bad" ? gate.promise : [dir("bad")]
    );

    const { rerender } = renderHook(
      (props: { expandedPaths: string[] }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: props.expandedPaths,
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
        }),
      { initialProps: { expandedPaths: ["bad"] } }
    );

    await waitFor(() =>
      expect(listDirectory.mock.calls.filter((c) => c[0].dirPath === "bad")).toHaveLength(1)
    );

    // Collapse while the request is still in flight, THEN let it reject.
    rerender({ expandedPaths: [] });
    await act(async () => {
      gate.reject(new Error("EACCES"));
      await gate.promise.catch(() => {});
    });

    rerender({ expandedPaths: ["bad"] });

    await waitFor(() =>
      expect(listDirectory.mock.calls.filter((c) => c[0].dirPath === "bad")).toHaveLength(2)
    );
  });

  it("reports an error when a folder cached as empty then fails to re-read", async () => {
    // An empty cached listing has nothing to protect, so claiming "ready" would
    // put "this folder is empty" on screen for a folder we in fact failed to
    // read — a confident claim built on a failure.
    let failNext = false;
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") {
        if (failNext) throw new Error("EACCES");
        return [];
      }
      return [dir("src")];
    });

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        selectedPath: "src",
      })
    );

    await waitFor(() => expect(result.current.listingRows).toEqual([]));
    expect(result.current.listingStatus).toBe("ready");

    failNext = true;
    act(() => result.current.refresh({ manual: true }));

    await waitFor(() => expect(result.current.listingStatus).toBe("error"));
  });

  it("keeps showing a populated listing whose re-read failed", async () => {
    // The other half of the same rule: real rows on screen are not blanked for
    // an error banner, matching the tree's own root-error branch.
    let failNext = false;
    listDirectory.mockImplementation(async (payload) => {
      if (payload.dirPath === "src") {
        if (failNext) throw new Error("EACCES");
        return [file("src/a.ts")];
      }
      return [dir("src")];
    });

    const { result } = renderHook(() =>
      useFileBrowserTree({
        source: wtSource("wt-1"),
        expandedPaths: [],
        hideDotfiles: false,
        alwaysHiddenPatterns: [],
        changeTick: undefined,
        selectedPath: "src",
      })
    );

    await waitFor(() => expect(result.current.listingRows?.length).toBe(1));

    failNext = true;
    act(() => result.current.refresh({ manual: true }));
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));

    expect(result.current.listingStatus).toBe("ready");
    expect(result.current.listingRows?.map((r) => r.path)).toEqual(["src/a.ts"]);
  });

  it("accepts a listing that lands while it is the selection's parent, not the listed folder", async () => {
    // The completion guard must agree with what the prune retains. A result
    // arriving after the user clicked into a file must still be accepted, or
    // the parent that identifies that file is never cached at all.
    const gate = deferred<FileTreeNode[]>();
    listDirectory.mockImplementation(async (payload) =>
      payload.dirPath === "src" ? gate.promise : [dir("src")]
    );

    const { result, rerender } = renderHook(
      (props: { selectedPath: string }) =>
        useFileBrowserTree({
          source: wtSource("wt-1"),
          expandedPaths: [],
          hideDotfiles: false,
          alwaysHiddenPatterns: [],
          changeTick: undefined,
          selectedPath: props.selectedPath,
        }),
      { initialProps: { selectedPath: "src" } }
    );

    await waitFor(() => expect(result.current.listingStatus).toBe("pending"));

    // Selection moves to a child before the parent's listing lands, so "src" is
    // now selectionParent rather than listingPath.
    rerender({ selectedPath: "src/a.ts" });
    await act(async () => {
      gate.resolve([file("src/a.ts")]);
      await gate.promise;
    });

    await waitFor(() => expect(result.current.selectedNode?.path).toBe("src/a.ts"));
    expect(result.current.selectedNode?.isDirectory).toBe(false);
  });

  // ---- Scoped refresh: re-list only the directories a change touched (#12244) ----

  describe("scoped refresh", () => {
    /**
     * A three-directory tree, fully expanded, so a scoped tick has somewhere to
     * NOT go. Every listing is served from the shape rather than a queue, so a
     * re-list returns the same content and only the call log distinguishes a
     * scoped pass from a full one.
     */
    function mockThreeBranches(): void {
      listDirectory.mockImplementation(async (payload) => {
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
    }

    const EXPANDED = ["a", "a/deep", "b"];

    /** A store record for one burst. */
    function burst(at: number, previousAt: number | null, dirs: readonly string[] | null) {
      return { at, previousAt, dirs };
    }

    /** Which directories a run of the hook asked for, root as "". */
    function requested(fromCall: number): string[] {
      return listDirectory.mock.calls.slice(fromCall).map((call) => call[0].dirPath ?? "");
    }

    interface TickProps {
      changeTick: number | undefined;
      changedDirs: ReturnType<typeof burst> | undefined;
      gitChangeTick?: number;
      rootPath?: string;
      selectedPath?: string | null;
    }

    async function mountTree(initialProps: TickProps) {
      const harness = renderHook(
        (props: TickProps) =>
          useFileBrowserTree({
            source: wtSource("wt-1"),
            expandedPaths: EXPANDED,
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
            changeTick: props.changeTick,
            changedDirs: props.changedDirs,
            gitChangeTick: props.gitChangeTick,
            rootPath: props.rootPath,
            selectedPath: props.selectedPath ?? null,
          }),
        { initialProps }
      );
      // The root plus the three expanded directories — waiting on the request
      // count rather than a row tally keeps the helper usable by the arm where
      // one of those listings deliberately fails.
      await waitFor(() => expect(listDirectory.mock.calls.length).toBe(4));
      await act(() => settle());
      return harness;
    }

    /**
     * The first tick under an identity can never be scoped — there is no
     * consumed stamp for the record to chain off — so every scoped assertion
     * spends one full tick establishing the cursor first. That is the shipped
     * behaviour, not a test artefact: one full sweep per panel lifetime buys a
     * continuity proof for every tick after it.
     */
    async function primeCursor(
      rerender: (props: TickProps) => void,
      base: TickProps
    ): Promise<void> {
      rerender({ ...base, changeTick: 100, changedDirs: burst(100, null, ["a"]) });
      await act(() => settle());
    }

    it("re-lists only the touched directory, leaving the rest of the tree alone", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a/deep"]) });
      await act(() => settle());

      expect(requested(from)).toEqual(["a/deep"]);
    });

    it("re-lists only the root when a top-level entry changed", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, [""]) });
      await act(() => settle());

      expect(requested(from)).toEqual([""]);
    });

    it("re-lists each touched directory once when one burst spans several", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a", "b"]) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["a", "b"]);
    });

    it("ignores a touched directory that is not on screen", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      // Nothing renders this directory, so re-reading it would buy nothing.
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["c/unexpanded"]) });
      await act(() => settle());

      expect(requested(from)).toEqual([]);
    });

    it("falls back to the full sweep when the burst could not be described", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, null) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("falls back to the full sweep with no record at all", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: undefined });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("falls back to the full sweep when a git-status tick outran the burst", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      // The tick moved to 300 but the newest burst is still stamped 200: a git
      // status pass moved it, and that pass describes no directories.
      rerender({ ...base, changeTick: 300, changedDirs: burst(200, 100, ["a"]) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("falls back to the full sweep when a burst went by unseen", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      // Two bursts landed but React committed once: this record supersedes 150,
      // not the 100 the tree last acted on, so 150's directories are lost.
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 150, ["a"]) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("takes the full sweep on the first tick, then scopes the next one", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);

      const firstFrom = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 100, changedDirs: burst(100, null, ["a"]) });
      await act(() => settle());
      expect(requested(firstFrom).sort()).toEqual(["", "a", "a/deep", "b"]);

      const secondFrom = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a"]) });
      await act(() => settle());
      expect(requested(secondFrom)).toEqual(["a"]);
    });

    it("advances the cursor across a full sweep so the tick after it scopes", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      // An unclassifiable burst — full sweep, but the cursor still moves to 200.
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, null) });
      await act(() => settle());

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 300, changedDirs: burst(300, 200, ["b"]) });
      await act(() => settle());
      expect(requested(from)).toEqual(["b"]);
    });

    it("keeps a manual refresh a full sweep whatever the last burst said", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { result, rerender } = await mountTree(base);
      await primeCursor(rerender, base);
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a"]) });
      await act(() => settle());

      const from = listDirectory.mock.calls.length;
      await act(async () => {
        result.current.refresh({ manual: true });
        await settle();
      });

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("takes the full sweep when the change is above a browse root it cannot see", async () => {
      // Rooted at "a": the tree holds no listing for "" , so a rename of "a"
      // itself is only discoverable by re-reading the root.
      listDirectory.mockImplementation(async (payload) => {
        switch (payload.dirPath) {
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined, rootPath: "a" };
      const harness = renderHook(
        (props: TickProps) =>
          useFileBrowserTree({
            source: wtSource("wt-1"),
            expandedPaths: ["a/deep"],
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
            changeTick: props.changeTick,
            changedDirs: props.changedDirs,
            rootPath: props.rootPath,
          }),
        { initialProps: base }
      );
      await waitFor(() => expect(harness.result.current.rows).toHaveLength(3));
      await primeCursor(harness.rerender, base);

      const from = listDirectory.mock.calls.length;
      harness.rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, [""]) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["a", "a/deep"]);
    });

    it("retries a failed listing on a scoped tick that did not touch it", async () => {
      let failDeep = true;
      listDirectory.mockImplementation(async (payload) => {
        if (payload.dirPath === "a/deep") {
          if (failDeep) throw new Error("nope");
          return [file("a/deep/two.ts")];
        }
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { result, rerender } = await mountTree(base);
      await primeCursor(rerender, base);
      failDeep = false;

      const from = listDirectory.mock.calls.length;
      // The burst touched "b" only, but a full sweep used to retry every failed
      // directory for free and scoping must not quietly end that.
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["b"]) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["a/deep", "b"]);
      await waitFor(() =>
        expect(result.current.rows.map((row) => row.path)).toContain("a/deep/two.ts")
      );
    });

    it("defers a scoped refresh that collided with an in-flight read, then replays it", async () => {
      const gate = deferred<FileTreeNode[]>();
      let holdDeep = false;
      listDirectory.mockImplementation(async (payload) => {
        if (payload.dirPath === "a/deep" && holdDeep) return gate.promise;
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      // First scoped tick opens a read of "a/deep" and holds it.
      holdDeep = true;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a/deep"]) });
      await act(() => settle());
      const from = listDirectory.mock.calls.length;

      // A second burst arrives while that read is still open. Its own directory
      // is free, so it goes out immediately; "a/deep" cannot be trusted from the
      // read that started before the change, so it has to be re-read after.
      rerender({ ...base, changeTick: 300, changedDirs: burst(300, 200, ["a/deep", "b"]) });
      await act(() => settle());
      expect(requested(from)).toEqual(["b"]);

      holdDeep = false;
      await act(async () => {
        gate.resolve([file("a/deep/two.ts")]);
        await settle();
      });

      // The replay is the union of what collided — "a/deep" — and nothing wider.
      expect(requested(from).sort()).toEqual(["a/deep", "b"]);
    });

    it("unions successive deferred scopes rather than keeping only the last", async () => {
      // Two directories held open at once, each collided by its own tick. If
      // the merge kept only the newest scope, the first collision's directory
      // would never be re-read — the exact "mutations arrive while a refresh is
      // in flight get dropped" failure.
      const deepGate = deferred<FileTreeNode[]>();
      const bGate = deferred<FileTreeNode[]>();
      let holdDeep = false;
      let holdB = false;
      listDirectory.mockImplementation(async (payload) => {
        if (payload.dirPath === "a/deep" && holdDeep) return deepGate.promise;
        if (payload.dirPath === "b" && holdB) return bGate.promise;
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      // Open a read of "a/deep" and hold it.
      holdDeep = true;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a/deep"]) });
      await act(() => settle());

      // Open a read of "b" and hold that too.
      holdB = true;
      rerender({ ...base, changeTick: 300, changedDirs: burst(300, 200, ["b"]) });
      await act(() => settle());

      // Now collide with BOTH, one tick at a time, so two separate deferrals
      // accumulate.
      rerender({ ...base, changeTick: 400, changedDirs: burst(400, 300, ["a/deep"]) });
      await act(() => settle());
      rerender({ ...base, changeTick: 500, changedDirs: burst(500, 400, ["b"]) });
      await act(() => settle());

      // Boundary taken immediately before the gates release, so the replay's
      // requests are the only thing measured.
      const from = listDirectory.mock.calls.length;
      holdDeep = false;
      holdB = false;
      await act(async () => {
        deepGate.resolve([file("a/deep/two.ts")]);
        bGate.resolve([file("b/three.ts")]);
        await settle();
      });

      expect(requested(from).sort()).toEqual(["a/deep", "b"]);
    });

    it("widens a deferred scope to the whole tree when a manual refresh collides", async () => {
      const gate = deferred<FileTreeNode[]>();
      let holdDeep = false;
      listDirectory.mockImplementation(async (payload) => {
        if (payload.dirPath === "a/deep" && holdDeep) return gate.promise;
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { result, rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      holdDeep = true;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["a/deep"]) });
      await act(() => settle());

      await act(async () => {
        result.current.refresh({ manual: true });
        await settle();
      });

      // The boundary goes AFTER the manual press: the press issues its own
      // requests for every idle target, and counting those would let a replay
      // of the single deferred directory masquerade as a full sweep.
      const from = listDirectory.mock.calls.length;
      holdDeep = false;
      await act(async () => {
        gate.resolve([file("a/deep/two.ts")]);
        await settle();
      });

      // The manual press promoted the deferred scope, so the replay itself is
      // the full sweep rather than the one directory the tick asked for.
      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("re-reads a directory that was replaced in place, and cascades down it", async () => {
      // `rm -rf b && mv b.tmp b`: the name survives, so re-reading the parent
      // shows `b` exactly as before and the stale cache underneath would stay
      // on screen. The directory's own mtime is what gives the swap away.
      let bMtime = 1_000;
      const deepMtime = 5_000;
      let swapped = false;
      listDirectory.mockImplementation(async (payload) => {
        switch (payload.dirPath) {
          case undefined:
            return [
              { name: "a", path: "a", isDirectory: true, mtimeMs: 100 },
              { name: "b", path: "b", isDirectory: true, mtimeMs: bMtime },
              file("top.txt"),
            ];
          case "a":
            return [{ name: "deep", path: "a/deep", isDirectory: true, mtimeMs: deepMtime }];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file(swapped ? "b/replaced.ts" : "b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const harness = renderHook(
        (props: TickProps) =>
          useFileBrowserTree({
            source: wtSource("wt-1"),
            expandedPaths: EXPANDED,
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
            changeTick: props.changeTick,
            changedDirs: props.changedDirs,
          }),
        { initialProps: base }
      );
      await waitFor(() => expect(listDirectory.mock.calls.length).toBe(4));
      await act(() => settle());
      await primeCursor(harness.rerender, base);

      // The swap. The watcher saw only the directory itself move, so the burst
      // names its PARENT — the root — and nothing below.
      swapped = true;
      bMtime = 2_000;
      const from = listDirectory.mock.calls.length;
      harness.rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, [""]) });
      await act(() => settle());

      // The root re-read plus `b`, which the mtime comparison caught.
      expect(requested(from).sort()).toEqual(["", "b"]);
      await waitFor(() =>
        expect(harness.result.current.rows.map((row) => row.path)).toContain("b/replaced.ts")
      );
      expect(harness.result.current.rows.map((row) => row.path)).not.toContain("b/three.ts");
    });

    it("leaves an unchanged sibling alone when one directory was replaced", async () => {
      // The cascade must be driven by the mtime, not by "the parent was read".
      listDirectory.mockImplementation(async (payload) => {
        switch (payload.dirPath) {
          case undefined:
            return [
              { name: "a", path: "a", isDirectory: true, mtimeMs: 100 },
              { name: "b", path: "b", isDirectory: true, mtimeMs: 200 },
              file("top.txt"),
            ];
          case "a":
            return [{ name: "deep", path: "a/deep", isDirectory: true, mtimeMs: 300 }];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const harness = renderHook(
        (props: TickProps) =>
          useFileBrowserTree({
            source: wtSource("wt-1"),
            expandedPaths: EXPANDED,
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
            changeTick: props.changeTick,
            changedDirs: props.changedDirs,
          }),
        { initialProps: base }
      );
      await waitFor(() => expect(listDirectory.mock.calls.length).toBe(4));
      await act(() => settle());
      await primeCursor(harness.rerender, base);

      const from = listDirectory.mock.calls.length;
      harness.rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, [""]) });
      await act(() => settle());

      expect(requested(from)).toEqual([""]);
    });

    it("retries a root whose backoff budget is spent, on a tick that named something else", async () => {
      // A root failure is deliberately kept out of `failedListings`, so once the
      // backoff is spent the panel sits on an error banner. The full sweep
      // re-read the root every tick and cleared it; a scoped pass naming a
      // descendant must not lose that.
      let failRoot = false;
      listDirectory.mockImplementation(async (payload) => {
        if (payload.dirPath === undefined && failRoot) throw new Error("unreadable");
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { result, rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      // Spend the whole retry schedule on a failing root.
      failRoot = true;
      await act(async () => {
        result.current.refresh({ manual: true });
        await settle();
      });
      await waitFor(() => expect(result.current.rootError).not.toBeNull(), { timeout: 4000 });

      failRoot = false;
      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["b"]) });
      await act(() => settle());

      expect(requested(from)).toContain("");
      await waitFor(() => expect(result.current.rootError).toBeNull());
    });

    it("takes the full sweep while a directory symlink is on screen", async () => {
      // The alias is cached under the path the tree renders; the watcher
      // reports writes under the link's target. A scoped pass would leave the
      // alias stale, so its mere presence disables scoping (#11939).
      listDirectory.mockImplementation(async (payload) => {
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [
              {
                name: "deep",
                path: "a/deep",
                isDirectory: true,
                symlink: { target: "../generated", targetKind: "directory" as const },
              },
              file("a/one.ts"),
            ];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["b"]) });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("takes the full sweep when a git-status pass was batched behind a newer burst", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined, gitChangeTick: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      // git 150 then fs 200 in one commit: `Math.max` reports 200 and the burst
      // chain is intact, but git 150's own discovery was never re-read.
      rerender({
        ...base,
        changeTick: 200,
        gitChangeTick: 150,
        changedDirs: burst(200, 100, ["b"]),
      });
      await act(() => settle());

      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);

      // And once that git tick has been accounted for, scoping resumes.
      const next = listDirectory.mock.calls.length;
      rerender({
        ...base,
        changeTick: 300,
        gitChangeTick: 150,
        changedDirs: burst(300, 200, ["b"]),
      });
      await act(() => settle());
      expect(requested(next)).toEqual(["b"]);
    });

    it("asks for nothing on a burst that resolved to no directory", async () => {
      mockThreeBranches();
      const base: TickProps = { changeTick: 1, changedDirs: undefined };
      const { rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const from = listDirectory.mock.calls.length;
      // Known-empty is a real answer and must not be read as "unknown".
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, []) });
      await act(() => settle());

      expect(requested(from)).toEqual([]);

      // The cursor still advanced, so the next burst scopes.
      const next = listDirectory.mock.calls.length;
      rerender({ ...base, changeTick: 300, changedDirs: burst(300, 200, ["b"]) });
      await act(() => settle());
      expect(requested(next)).toEqual(["b"]);
    });

    it("resets the cursor on a worktree switch so the new tree's first tick is full", async () => {
      mockThreeBranches();
      const harness = renderHook(
        (props: TickProps & { worktreeId: string }) =>
          useFileBrowserTree({
            source: wtSource(props.worktreeId),
            expandedPaths: EXPANDED,
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
            changeTick: props.changeTick,
            changedDirs: props.changedDirs,
          }),
        {
          initialProps: {
            worktreeId: "wt-1",
            changeTick: 1,
            changedDirs: undefined,
          } as TickProps & { worktreeId: string },
        }
      );
      await waitFor(() => expect(listDirectory.mock.calls.length).toBe(4));
      await act(() => settle());
      harness.rerender({
        worktreeId: "wt-1",
        changeTick: 100,
        changedDirs: burst(100, null, ["a"]),
      });
      await act(() => settle());

      // Switch worktrees; the identity reset re-lists everything for wt-2.
      harness.rerender({
        worktreeId: "wt-2",
        changeTick: 100,
        changedDirs: burst(100, null, ["a"]),
      });
      await waitFor(() => expect(harness.result.current.rows).toHaveLength(7));
      await act(() => settle());

      // A continuous-looking burst under the NEW identity must still be full:
      // the cursor it would chain off belonged to the tree we left.
      const from = listDirectory.mock.calls.length;
      harness.rerender({
        worktreeId: "wt-2",
        changeTick: 200,
        changedDirs: burst(200, 100, ["b"]),
      });
      await act(() => settle());
      expect(requested(from).sort()).toEqual(["", "a", "a/deep", "b"]);
    });

    it("leaves selection and expansion untouched across a scoped pass", async () => {
      mockThreeBranches();
      const base: TickProps = {
        changeTick: 1,
        changedDirs: undefined,
        selectedPath: "a/deep/two.ts",
      };
      const { result, rerender } = await mountTree(base);
      await primeCursor(rerender, base);

      const rowsBefore = result.current.rows.map((row) => row.path);
      rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["b"]) });
      await act(() => settle());

      expect(result.current.rows.map((row) => row.path)).toEqual(rowsBefore);
      expect(result.current.selectedNode?.path).toBe("a/deep/two.ts");
    });

    it("re-reads the collapsed folder the viewer is listing when the change lands in it", async () => {
      listDirectory.mockImplementation(async (payload) => {
        switch (payload.dirPath) {
          case undefined:
            return [dir("a"), dir("b"), file("top.txt")];
          case "a":
            return [dir("a/deep"), file("a/one.ts")];
          case "a/deep":
            return [file("a/deep/two.ts")];
          case "b":
            return [file("b/three.ts")];
          default:
            return [];
        }
      });
      // "b" is selected as a folder but collapsed out of the tree, so only the
      // viewer depends on its listing.
      const base: TickProps = { changeTick: 1, changedDirs: undefined, selectedPath: "b" };
      const harness = renderHook(
        (props: TickProps) =>
          useFileBrowserTree({
            source: wtSource("wt-1"),
            expandedPaths: ["a"],
            hideDotfiles: false,
            alwaysHiddenPatterns: [],
            changeTick: props.changeTick,
            changedDirs: props.changedDirs,
            selectedPath: props.selectedPath ?? null,
          }),
        { initialProps: base }
      );
      await waitFor(() => expect(harness.result.current.listingStatus).toBe("ready"));
      await primeCursor(harness.rerender, base);

      const from = listDirectory.mock.calls.length;
      harness.rerender({ ...base, changeTick: 200, changedDirs: burst(200, 100, ["b"]) });
      await act(() => settle());
      expect(requested(from)).toEqual(["b"]);

      const next = listDirectory.mock.calls.length;
      harness.rerender({ ...base, changeTick: 300, changedDirs: burst(300, 200, ["a"]) });
      await act(() => settle());
      expect(requested(next)).toEqual(["a"]);
    });
  });
});

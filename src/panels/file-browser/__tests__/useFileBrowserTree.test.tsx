// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { FileTreeNode } from "@shared/types";
import type { FileBrowserListDirectoryPayload } from "@shared/types/ipc/fileBrowser";
import { useFileBrowserTree } from "../useFileBrowserTree";

const listDirectory = vi.fn<(payload: FileBrowserListDirectoryPayload) => Promise<FileTreeNode[]>>();

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
    expect(listDirectory.mock.calls.slice(-2).map((call) => call[0].dirPath).sort()).toEqual([
      "src",
      undefined,
    ]);
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

  it("surfaces a root failure and clears it once a retry succeeds", async () => {
    listDirectory.mockRejectedValueOnce(new Error("worktree is gone"));

    const { result } = renderHook(() =>
      useFileBrowserTree({
        worktreeId: "wt-1",
        expandedPaths: [],
        showIgnored: false,
        changeTick: undefined,
      })
    );

    await waitFor(() => expect(result.current.rootError).toContain("worktree is gone"));

    listDirectory.mockResolvedValue([file("a.ts")]);
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.rootError).toBeNull());
    expect(result.current.rows.map((row) => row.path)).toEqual(["a.ts"]);
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

    await waitFor(() =>
      expect(result.current.rows.map((row) => row.path)).toEqual(["second.ts"])
    );

    await act(async () => {
      slowFirst.resolve([file("first.ts")]);
    });

    expect(result.current.rows.map((row) => row.path)).toEqual(["second.ts"]);
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "@shared/types/ipc/git";
import { useReviewHubBaseBranch } from "../useReviewHubBaseBranch";

const compareWorktreesMock = vi.fn();
const setSelectedBaseBranchFile = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function result(paths: string[]): CrossWorktreeDiffResult {
  return {
    branch1: "main",
    branch2: "feature/x",
    files: paths.map((path) => ({ path, status: "M" }) as CrossWorktreeFile),
  };
}

interface Props {
  worktreePath: string;
  mainBranch: string;
  currentBranch: string | null;
  heads: string;
  active: boolean;
}

const PROPS: Props = {
  worktreePath: "/repo/wt",
  mainBranch: "main",
  currentBranch: "feature/x",
  heads: "base1..head1",
  active: false,
};

function setup(initial: Partial<Props> = {}) {
  let props: Props = { ...PROPS, ...initial };
  const hook = renderHook(
    (p: Props) => useReviewHubBaseBranch({ ...p, setSelectedBaseBranchFile }),
    {
      initialProps: props,
    }
  );
  const update = (next: Partial<Props>) => {
    props = { ...props, ...next };
    hook.rerender(props);
  };
  return { ...hook, update };
}

const paths = (files: CrossWorktreeFile[] | null) => files?.map((f) => f.path) ?? null;

afterEach(cleanup);

describe("useReviewHubBaseBranch", () => {
  beforeEach(() => {
    compareWorktreesMock.mockReset();
    setSelectedBaseBranchFile.mockReset();
    Object.defineProperty(window, "electron", {
      value: { git: { compareWorktrees: compareWorktreesMock } },
      writable: true,
      configurable: true,
    });
  });

  it("clears the loading flag when invalidated while a comparison is in flight", async () => {
    const first = deferred<CrossWorktreeDiffResult>();
    compareWorktreesMock.mockReturnValueOnce(first.promise);
    const { result: hook } = setup();

    act(() => void hook.current.fetchBaseBranch());
    expect(hook.current.baseBranchLoading).toBe(true);

    act(() => hook.current.invalidate());
    expect(hook.current.baseBranchLoading).toBe(false);

    // The abandoned answer lands without reviving the cache or the flag.
    await act(async () => {
      first.resolve(result(["stale.ts"]));
      await first.promise;
    });
    expect(hook.current.baseBranchLoading).toBe(false);
    expect(hook.current.baseBranchFiles).toBeNull();

    // And the next fetch isn't refused by a stranded flag.
    compareWorktreesMock.mockResolvedValueOnce(result(["fresh.ts"]));
    await act(async () => {
      await hook.current.fetchBaseBranch();
    });
    expect(paths(hook.current.baseBranchFiles)).toEqual(["fresh.ts"]);
    expect(hook.current.baseBranchLoading).toBe(false);
  });

  it("asks once when it comes on screen, and not again for the same tips", async () => {
    compareWorktreesMock.mockResolvedValue(result(["a.ts"]));
    const { result: hook, update } = setup();
    expect(compareWorktreesMock).not.toHaveBeenCalled();

    await act(async () => update({ active: true }));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);
    expect(compareWorktreesMock).toHaveBeenCalledWith(
      "/repo/wt",
      "main",
      "feature/x",
      undefined,
      true
    );
    expect(paths(hook.current.baseBranchFiles)).toEqual(["a.ts"]);

    await act(async () => update({ active: false }));
    await act(async () => update({ active: true }));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes behind the list when a tip moves while it is on screen", async () => {
    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    const { result: hook, update } = setup({ active: true });
    await act(async () => {});
    setSelectedBaseBranchFile.mockClear();

    const refresh = deferred<CrossWorktreeDiffResult>();
    compareWorktreesMock.mockReturnValueOnce(refresh.promise);
    act(() => update({ heads: "base1..head2" }));

    // The old list and the open file stay up while the new answer is out.
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
    expect(hook.current.baseBranchRefreshing).toBe(true);
    expect(hook.current.baseBranchLoading).toBe(false);
    expect(paths(hook.current.baseBranchFiles)).toEqual(["a.ts"]);

    await act(async () => {
      refresh.resolve(result(["a.ts", "b.ts"]));
      await refresh.promise;
    });
    expect(paths(hook.current.baseBranchFiles)).toEqual(["a.ts", "b.ts"]);
    expect(hook.current.baseBranchRefreshing).toBe(false);
    expect(setSelectedBaseBranchFile).not.toHaveBeenCalled();
  });

  it("refreshes when the base branch's tip moves too", async () => {
    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    const { result: hook, update } = setup({ active: true });
    await act(async () => {});

    // Merged into the base: nothing left ahead of it.
    compareWorktreesMock.mockResolvedValueOnce(result([]));
    await act(async () => update({ heads: "base2..head1" }));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
    expect(paths(hook.current.baseBranchFiles)).toEqual([]);
  });

  it("drops a refresh that a later tip move superseded", async () => {
    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    const { result: hook, update } = setup({ active: true });
    await act(async () => {});

    const older = deferred<CrossWorktreeDiffResult>();
    const newer = deferred<CrossWorktreeDiffResult>();
    compareWorktreesMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => update({ heads: "base1..head2" }));
    act(() => update({ heads: "base1..head3" }));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      newer.resolve(result(["c.ts"]));
      await newer.promise;
    });
    await act(async () => {
      older.resolve(result(["b.ts"]));
      await older.promise;
    });
    expect(paths(hook.current.baseBranchFiles)).toEqual(["c.ts"]);
    expect(hook.current.baseBranchRefreshing).toBe(false);
  });

  it("drops what it holds when a tip moves off screen, and asks again on the way back", async () => {
    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    const { result: hook, update } = setup({ active: true });
    await act(async () => {});
    await act(async () => update({ active: false }));

    await act(async () => update({ heads: "base1..head2" }));
    expect(hook.current.baseBranchFiles).toBeNull();
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);

    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts", "b.ts"]));
    await act(async () => update({ active: true }));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
    expect(paths(hook.current.baseBranchFiles)).toEqual(["a.ts", "b.ts"]);
  });

  it("asks from scratch for another branch, closing the open file", async () => {
    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    const { result: hook, update } = setup({ active: true });
    await act(async () => {});
    setSelectedBaseBranchFile.mockClear();

    const other = deferred<CrossWorktreeDiffResult>();
    compareWorktreesMock.mockReturnValueOnce(other.promise);
    act(() => update({ currentBranch: "feature/y", heads: "base1..head9" }));

    expect(compareWorktreesMock).toHaveBeenLastCalledWith(
      "/repo/wt",
      "main",
      "feature/y",
      undefined,
      true
    );
    // The previous branch's files never stand in for this one's.
    expect(hook.current.baseBranchFiles).toBeNull();
    expect(hook.current.baseBranchLoading).toBe(true);
    expect(setSelectedBaseBranchFile).toHaveBeenCalledWith(null);

    await act(async () => {
      other.resolve(result(["y.ts"]));
      await other.promise;
    });
    expect(paths(hook.current.baseBranchFiles)).toEqual(["y.ts"]);
  });

  it("asks from scratch when the base branch changes", async () => {
    compareWorktreesMock.mockResolvedValue(result(["a.ts"]));
    const { update } = setup({ active: true });
    await act(async () => {});

    await act(async () => update({ mainBranch: "develop" }));
    expect(compareWorktreesMock).toHaveBeenLastCalledWith(
      "/repo/wt",
      "develop",
      "feature/x",
      undefined,
      true
    );
    expect(setSelectedBaseBranchFile).toHaveBeenCalledWith(null);
  });

  it("refreshes for the hub's own commit before the store hears of it", async () => {
    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    const { result: hook } = setup({ active: true });
    await act(async () => {});

    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts", "b.ts"]));
    await act(async () => hook.current.notifyHeadMoved("/repo/other"));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);

    await act(async () => hook.current.notifyHeadMoved("/repo/wt"));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
    expect(paths(hook.current.baseBranchFiles)).toEqual(["a.ts", "b.ts"]);
  });

  it("doesn't retry a failure on its own, but does on coming back", async () => {
    compareWorktreesMock.mockRejectedValueOnce(new Error("bad object"));
    const { result: hook, update } = setup({ active: true });
    await act(async () => {});
    expect(hook.current.baseBranchError).toContain("bad object");

    // Unrelated re-renders leave the failure alone.
    await act(async () => update({}));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);

    compareWorktreesMock.mockResolvedValueOnce(result(["a.ts"]));
    await act(async () => update({ active: false }));
    await act(async () => update({ active: true }));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
    expect(hook.current.baseBranchError).toBeNull();
    expect(paths(hook.current.baseBranchFiles)).toEqual(["a.ts"]);
  });

  it("asks nothing while the branch is unknown or is the base itself", async () => {
    setup({ active: true, currentBranch: null });
    setup({ active: true, currentBranch: "main" });
    await act(async () => {});
    expect(compareWorktreesMock).not.toHaveBeenCalled();
  });
});

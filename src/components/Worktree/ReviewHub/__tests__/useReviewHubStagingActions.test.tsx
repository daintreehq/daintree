// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StagingFileEntry } from "@shared/types";
import type { FileStageRowSection } from "../FileStageRow";
import {
  useReviewHubStagingActions,
  type ReviewHubActionFailure,
} from "../useReviewHubStagingActions";

// A grid hub moved from A to B while a write for A was still out (#17584).
const A = "/repo/a";
const B = "/repo/b";

const git = {
  stageFile: vi.fn<(cwd: string, path: string) => Promise<void>>(),
  unstageFile: vi.fn<(cwd: string, path: string) => Promise<void>>(),
  stageFiles: vi.fn<(cwd: string, paths: string[]) => Promise<void>>(),
  unstageFiles: vi.fn<(cwd: string, paths: string[]) => Promise<void>>(),
  stageAll: vi.fn<(cwd: string) => Promise<void>>(),
  unstageAll: vi.fn<(cwd: string) => Promise<void>>(),
};

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function entry(path: string): StagingFileEntry {
  return { path, status: "modified", insertions: 1, deletions: 0 };
}

interface Props {
  path: string;
  selected: string[];
  section: FileStageRowSection | null;
}

function renderActions(initial: Partial<Props> & { path: string }) {
  // Stands in for the status hook's answer: the worktree the hub is on now.
  let openPath = initial.path;
  const isOpenPath = (path: string) => path === openPath;
  const refresh = vi.fn(async () => {});
  const setActionError = vi.fn<(failure: ReviewHubActionFailure | null) => void>();
  const setSelectedPaths = vi.fn();
  const setSelectionSection = vi.fn();
  const view = renderHook(
    ({ path, selected, section }: Props) =>
      useReviewHubStagingActions({
        worktreePath: path,
        isOpenPath,
        refresh,
        derivedStaged: [entry("src/s1.ts"), entry("src/s2.ts")],
        derivedUnstaged: [entry("src/u1.ts")],
        unstaged: [entry("src/u1.ts")],
        selectedPaths: new Set(selected),
        selectionSection: section,
        setActionError,
        setSelectedPaths,
        setSelectionSection,
        selectionAnchorRef: { current: null },
        debouncedBgRefreshRef: { current: null },
      }),
    {
      initialProps: {
        path: initial.path,
        selected: initial.selected ?? [],
        section: initial.section ?? null,
      },
    }
  );
  const moveTo = (path: string, selected: string[] = [], section: Props["section"] = null) => {
    openPath = path;
    view.rerender({ path, selected, section });
  };
  const lastRetry = (): (() => void) => {
    const retry = setActionError.mock.calls.at(-1)?.[0]?.retry;
    if (!retry) throw new Error("no failure with a Retry was reported");
    return retry;
  };
  return {
    ...view,
    refresh,
    setActionError,
    setSelectedPaths,
    setSelectionSection,
    moveTo,
    lastRetry,
  };
}

beforeEach(() => {
  for (const fn of Object.values(git)) fn.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, "electron", {
    value: { git },
    writable: true,
    configurable: true,
  });
});

describe("useReviewHubStagingActions after the hub moves to another worktree", () => {
  it("never runs a row's Retry kept from the previous worktree", async () => {
    git.stageFile.mockRejectedValueOnce(new Error("index.lock exists"));
    const hub = renderActions({ path: A });
    await act(async () => {
      await hub.result.current.handleStageFile("src/u1.ts");
    });
    const retry = hub.lastRetry();

    hub.moveTo(B);
    hub.setActionError.mockClear();
    await act(async () => {
      retry();
    });

    expect(git.stageFile).toHaveBeenCalledTimes(1);
    expect(hub.setActionError).not.toHaveBeenCalled();
  });

  it("never runs a selection's Retry kept from the previous worktree", async () => {
    git.stageFiles.mockRejectedValueOnce(new Error("index.lock exists"));
    const hub = renderActions({ path: A, selected: ["src/u1.ts"], section: "unstaged" });
    await act(async () => {
      await hub.result.current.handleStageSelection();
    });
    const retry = hub.lastRetry();

    hub.moveTo(B);
    hub.setActionError.mockClear();
    await act(async () => {
      retry();
    });

    expect(git.stageFiles).toHaveBeenCalledTimes(1);
    expect(hub.setActionError).not.toHaveBeenCalled();
  });

  it("drops a selection Retry's failure that lands after the move", async () => {
    git.stageFiles.mockRejectedValueOnce(new Error("index.lock exists"));
    const retryWrite = deferred();
    git.stageFiles.mockImplementationOnce(() => retryWrite.promise);
    const hub = renderActions({ path: A, selected: ["src/u1.ts"], section: "unstaged" });
    await act(async () => {
      await hub.result.current.handleStageSelection();
    });
    act(() => hub.lastRetry()());
    expect(git.stageFiles).toHaveBeenLastCalledWith(A, ["src/u1.ts"]);

    hub.moveTo(B);
    hub.setActionError.mockClear();
    await act(async () => {
      retryWrite.reject(new Error("still locked"));
    });

    expect(hub.setActionError).not.toHaveBeenCalled();
  });

  it("drops a filtered unstage's failure that lands after the move", async () => {
    const write = deferred();
    git.unstageFiles.mockImplementationOnce(() => write.promise);
    const hub = renderActions({ path: A });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hub.result.current.handleUnstageFiltered();
    });
    expect(git.unstageFiles).toHaveBeenCalledWith(A, ["src/s1.ts", "src/s2.ts"]);

    hub.moveTo(B);
    hub.setActionError.mockClear();
    await act(async () => {
      write.reject(new Error("index.lock exists"));
      await pending;
    });

    expect(hub.setActionError).not.toHaveBeenCalled();
  });

  it("leaves the new worktree's selection alone when an unstage selection succeeds late", async () => {
    const write = deferred();
    git.unstageFiles.mockImplementationOnce(() => write.promise);
    const hub = renderActions({ path: A, selected: ["src/s1.ts"], section: "staged" });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hub.result.current.handleUnstageSelection();
    });

    hub.moveTo(B, ["src/s2.ts"], "staged");
    await act(async () => {
      write.resolve();
      await pending;
    });

    expect(hub.setSelectedPaths).not.toHaveBeenCalled();
    expect(hub.setSelectionSection).not.toHaveBeenCalled();
    expect(hub.refresh).not.toHaveBeenCalled();
  });

  it("lets the new worktree stage its selection while the old one's is still out", async () => {
    const write = deferred();
    git.stageFiles.mockImplementationOnce(() => write.promise);
    const hub = renderActions({ path: A, selected: ["src/u1.ts"], section: "unstaged" });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hub.result.current.handleStageSelection();
    });

    hub.moveTo(B, ["src/u1.ts"], "unstaged");
    await act(async () => {
      await hub.result.current.handleStageSelection();
    });

    expect(git.stageFiles).toHaveBeenCalledTimes(2);
    expect(git.stageFiles).toHaveBeenLastCalledWith(B, ["src/u1.ts"]);
    await act(async () => {
      write.resolve();
      await pending;
    });
  });

  it("still refuses a second selection write on the same worktree while the first is out", async () => {
    const write = deferred();
    git.stageFiles.mockImplementationOnce(() => write.promise);
    const hub = renderActions({ path: A, selected: ["src/u1.ts"], section: "unstaged" });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hub.result.current.handleStageSelection();
    });
    await act(async () => {
      await hub.result.current.handleStageSelection();
    });

    expect(git.stageFiles).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.resolve();
      await pending;
    });
  });
});

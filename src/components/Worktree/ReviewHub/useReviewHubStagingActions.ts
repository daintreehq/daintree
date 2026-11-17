import { useCallback, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { StagingFileEntry } from "@shared/types";
import type { debounce } from "@/utils/debounce";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useLatestGetter } from "@/hooks/useLatestGetter";
import type { FileStageRowSection } from "./FileStageRow";

/**
 * A failed review-hub operation. The title is the operation, so the banner can
 * lead with what the user was doing ("Couldn't stage files") instead of a
 * generic label; the detail is git's own message, demoted to supporting copy.
 * Keeping them separate is what stops raw stderr becoming the headline.
 */
export interface ReviewHubActionFailure {
  title: string;
  detail: string;
  /**
   * Re-runs the operation that failed, with the scope it had when it failed.
   * Absent when re-running would skip a confirmation or is not meaningful; the
   * banner then offers no Retry rather than one that only re-reads status.
   */
  retry?: () => void;
}

interface UseReviewHubStagingActionsArgs {
  worktreePath: string;
  /**
   * Whether the hub is still on `path`. A grid hub moves between worktrees
   * while mounted, so a write that settles after a move answers for a
   * worktree no longer on screen: its failure, Retry, and selection clearing
   * would all land on the new one.
   */
  isOpenPath: (path: string) => boolean;
  refresh: () => Promise<void>;
  derivedStaged: StagingFileEntry[];
  derivedUnstaged: StagingFileEntry[];
  /** Every unstaged row as last read, before any filter; null before any read. */
  unstaged: readonly StagingFileEntry[] | null;
  selectedPaths: Set<string>;
  selectionSection: FileStageRowSection | null;
  setActionError: (failure: ReviewHubActionFailure | null) => void;
  setSelectedPaths: Dispatch<SetStateAction<Set<string>>>;
  setSelectionSection: Dispatch<SetStateAction<FileStageRowSection | null>>;
  selectionAnchorRef: RefObject<string | null>;
  debouncedBgRefreshRef: RefObject<ReturnType<typeof debounce> | null>;
}

export interface UseReviewHubStagingActionsReturn {
  handleStageFile: (filePath: string) => Promise<void>;
  handleUnstageFile: (filePath: string) => Promise<void>;
  handleStageAll: () => Promise<void>;
  handleUnstageAll: () => Promise<void>;
  handleStageFiltered: () => Promise<void>;
  handleUnstageFiltered: () => Promise<void>;
  handleStageSelection: () => Promise<void>;
  handleUnstageSelection: () => Promise<void>;
  handleToggleStaged: (filePath: string) => void;
  handleToggleUnstaged: (filePath: string) => void;
}

export function useReviewHubStagingActions({
  worktreePath,
  isOpenPath,
  refresh,
  derivedStaged,
  derivedUnstaged,
  unstaged,
  selectedPaths,
  selectionSection,
  setActionError,
  setSelectedPaths,
  setSelectionSection,
  selectionAnchorRef,
  debouncedBgRefreshRef,
}: UseReviewHubStagingActionsArgs): UseReviewHubStagingActionsReturn {
  // Per worktree: a selection write still pending on one the hub has left must
  // not refuse the next worktree's.
  const bulkStagingPathsRef = useRef(new Set<string>());
  const getView = useLatestGetter({ worktreePath, unstaged });
  const writeIdRef = useRef(0);

  /** Starts a write: clears the last failure and supersedes any write still reporting. */
  const beginWrite = useCallback((): number => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    return ++writeIdRef.current;
  }, [setActionError, debouncedBgRefreshRef]);

  /**
   * Whether the hub still shows `cwd`; reads and failures there are no longer
   * this view's. `isOpenPath` moves in a layout effect, so an answer that lands
   * between a switch's commit and its passive effects already sees the move.
   */
  const isShowing = useCallback(
    (cwd: string) => isOpenPath(cwd) && getView().worktreePath === cwd,
    [isOpenPath, getView]
  );

  /** Whether write `id`'s failure may still be reported: no newer write has started since. */
  const mayReport = useCallback(
    (id: number, cwd: string) => writeIdRef.current === id && isShowing(cwd),
    [isShowing]
  );

  // A large stage runs in batches, so one that failed partway has already
  // staged some paths. Its Retry sends only the paths still unstaged: git
  // refuses to add a deletion it has already staged, so a replay of the whole
  // list would fail on it every time. Rows from another worktree, or no read
  // yet, narrow nothing.
  const stillUnstaged = useCallback(
    (cwd: string, paths: readonly string[]): string[] => {
      const view = getView();
      if (view.worktreePath !== cwd || view.unstaged === null) return [...paths];
      const live = new Set(view.unstaged.map((file) => file.path));
      return paths.filter((path) => live.has(path));
    },
    [getView]
  );

  /**
   * Writes `scope`, reads status, and only then reports a failure, so what
   * landed shows first and a stage Retry narrows `paths` against that read
   * rather than the one before the failure. An unstage Retry replays every
   * path, which both of Main's unstage commands take quietly. Nothing is
   * reported once a newer write or another worktree has taken the hub.
   */
  const writePaths = useCallback(
    async (
      kind: "stage" | "unstage",
      paths: string[],
      scope: string[],
      failure: { title: string; fallback: string }
    ): Promise<void> => {
      const cwd = worktreePath;
      const attempt = async (attemptScope: string[]): Promise<void> => {
        // A Retry kept from a worktree the hub has left writes nothing.
        if (!isOpenPath(cwd)) return;
        const id = beginWrite();
        let error: { cause: unknown } | null = null;
        try {
          if (attemptScope.length > 0) {
            await (kind === "stage"
              ? window.electron.git.stageFiles(cwd, attemptScope)
              : window.electron.git.unstageFiles(cwd, attemptScope));
          }
        } catch (err) {
          error = { cause: err };
        }
        if (!isShowing(cwd)) return;
        await refresh();
        if (!error || !mayReport(id, cwd)) return;
        setActionError({
          title: failure.title,
          detail: formatErrorMessage(error.cause, failure.fallback),
          retry: () => void attempt(kind === "stage" ? stillUnstaged(cwd, paths) : paths),
        });
      };
      await attempt(scope);
    },
    [
      worktreePath,
      isOpenPath,
      refresh,
      setActionError,
      beginWrite,
      isShowing,
      mayReport,
      stillUnstaged,
    ]
  );

  const handleStageFile = useCallback(
    async (filePath: string) => {
      const attempt = async (): Promise<void> => {
        if (!isOpenPath(worktreePath)) return;
        const id = beginWrite();
        try {
          await window.electron.git.stageFile(worktreePath, filePath);
          await refresh();
        } catch (err) {
          if (!mayReport(id, worktreePath)) return;
          setActionError({
            title: "Couldn't stage file",
            detail: formatErrorMessage(err, "Failed to stage file"),
            retry: () => void attempt(),
          });
        }
      };
      await attempt();
    },
    [worktreePath, isOpenPath, refresh, setActionError, beginWrite, mayReport]
  );

  const handleUnstageFile = useCallback(
    async (filePath: string) => {
      const attempt = async (): Promise<void> => {
        if (!isOpenPath(worktreePath)) return;
        const id = beginWrite();
        try {
          await window.electron.git.unstageFile(worktreePath, filePath);
          await refresh();
        } catch (err) {
          if (!mayReport(id, worktreePath)) return;
          setActionError({
            title: "Couldn't unstage file",
            detail: formatErrorMessage(err, "Failed to unstage file"),
            retry: () => void attempt(),
          });
        }
      };
      await attempt();
    },
    [worktreePath, isOpenPath, refresh, setActionError, beginWrite, mayReport]
  );

  const handleStageAll = useCallback(async () => {
    const attempt = async (): Promise<void> => {
      if (!isOpenPath(worktreePath)) return;
      const id = beginWrite();
      try {
        await window.electron.git.stageAll(worktreePath);
        await refresh();
      } catch (err) {
        if (!mayReport(id, worktreePath)) return;
        setActionError({
          title: "Couldn't stage all files",
          detail: formatErrorMessage(err, "Failed to stage all files"),
          retry: () => void attempt(),
        });
      }
    };
    await attempt();
  }, [worktreePath, isOpenPath, refresh, setActionError, beginWrite, mayReport]);

  const handleUnstageAll = useCallback(async () => {
    const attempt = async (): Promise<void> => {
      if (!isOpenPath(worktreePath)) return;
      const id = beginWrite();
      try {
        await window.electron.git.unstageAll(worktreePath);
        await refresh();
      } catch (err) {
        if (!mayReport(id, worktreePath)) return;
        setActionError({
          title: "Couldn't unstage all files",
          detail: formatErrorMessage(err, "Failed to unstage all files"),
          retry: () => void attempt(),
        });
      }
    };
    await attempt();
  }, [worktreePath, isOpenPath, refresh, setActionError, beginWrite, mayReport]);

  const handleStageFiltered = useCallback(async () => {
    const paths = derivedUnstaged.map((f) => f.path);
    if (paths.length === 0) return;
    await writePaths("stage", paths, paths, {
      title: "Couldn't stage files",
      fallback: "Failed to stage files",
    });
  }, [derivedUnstaged, writePaths]);

  const handleUnstageFiltered = useCallback(async () => {
    const paths = derivedStaged.map((f) => f.path);
    if (paths.length === 0) return;
    await writePaths("unstage", paths, paths, {
      title: "Couldn't unstage files",
      fallback: "Failed to unstage files",
    });
  }, [derivedStaged, writePaths]);

  const handleStageSelection = useCallback(async () => {
    if (bulkStagingPathsRef.current.has(worktreePath)) return;
    if (selectionSection !== "unstaged" || selectedPaths.size === 0) return;
    const cwd = worktreePath;
    bulkStagingPathsRef.current.add(cwd);
    const paths = Array.from(selectedPaths);
    const id = beginWrite();
    try {
      await window.electron.git.stageFiles(cwd, paths);
      // The selection on screen now is another worktree's.
      if (!isOpenPath(cwd)) return;
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      await refresh();
    } catch (err) {
      if (!isShowing(cwd)) return;
      // Part of a large selection may have landed before the failure.
      await refresh();
      if (!mayReport(id, cwd)) return;
      // The selection's own paths, captured at the click: by the time Retry
      // is pressed the selection may have moved on.
      setActionError({
        title: "Couldn't stage selected files",
        detail: formatErrorMessage(err, "Failed to stage selected files"),
        retry: () =>
          void writePaths("stage", paths, stillUnstaged(cwd, paths), {
            title: "Couldn't stage files",
            fallback: "Failed to stage selected files",
          }),
      });
    } finally {
      bulkStagingPathsRef.current.delete(cwd);
    }
  }, [
    worktreePath,
    isOpenPath,
    refresh,
    selectedPaths,
    selectionSection,
    setActionError,
    setSelectedPaths,
    setSelectionSection,
    selectionAnchorRef,
    beginWrite,
    isShowing,
    mayReport,
    stillUnstaged,
    writePaths,
  ]);

  const handleUnstageSelection = useCallback(async () => {
    if (bulkStagingPathsRef.current.has(worktreePath)) return;
    if (selectionSection !== "staged" || selectedPaths.size === 0) return;
    const cwd = worktreePath;
    bulkStagingPathsRef.current.add(cwd);
    const paths = Array.from(selectedPaths);
    const id = beginWrite();
    try {
      await window.electron.git.unstageFiles(cwd, paths);
      // The selection on screen now is another worktree's.
      if (!isOpenPath(cwd)) return;
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      await refresh();
    } catch (err) {
      if (!isShowing(cwd)) return;
      // Part of a large selection may have landed before the failure.
      await refresh();
      if (!mayReport(id, cwd)) return;
      // The selection's own paths, captured at the click: by the time Retry
      // is pressed the selection may have moved on.
      setActionError({
        title: "Couldn't unstage selected files",
        detail: formatErrorMessage(err, "Failed to unstage selected files"),
        retry: () =>
          void writePaths("unstage", paths, paths, {
            title: "Couldn't unstage files",
            fallback: "Failed to unstage selected files",
          }),
      });
    } finally {
      bulkStagingPathsRef.current.delete(cwd);
    }
  }, [
    worktreePath,
    isOpenPath,
    refresh,
    selectedPaths,
    selectionSection,
    setActionError,
    setSelectedPaths,
    setSelectionSection,
    selectionAnchorRef,
    beginWrite,
    isShowing,
    mayReport,
    writePaths,
  ]);

  const handleToggleStaged = useCallback(
    (filePath: string) => {
      void handleUnstageFile(filePath);
    },
    [handleUnstageFile]
  );

  const handleToggleUnstaged = useCallback(
    (filePath: string) => {
      void handleStageFile(filePath);
    },
    [handleStageFile]
  );

  return {
    handleStageFile,
    handleUnstageFile,
    handleStageAll,
    handleUnstageAll,
    handleStageFiltered,
    handleUnstageFiltered,
    handleStageSelection,
    handleUnstageSelection,
    handleToggleStaged,
    handleToggleUnstaged,
  };
}

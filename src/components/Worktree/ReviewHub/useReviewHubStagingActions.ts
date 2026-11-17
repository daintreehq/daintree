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
  const isBulkStagingRef = useRef(false);
  const getView = useLatestGetter({ worktreePath, unstaged });

  /** Whether the hub still shows `cwd`; a failure there is not this view's to report. */
  const isShowing = useCallback((cwd: string) => getView().worktreePath === cwd, [getView]);

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
   * reported once the hub shows another worktree.
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
        setActionError(null);
        debouncedBgRefreshRef.current?.cancel();
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
        if (!error || !isShowing(cwd)) return;
        setActionError({
          title: failure.title,
          detail: formatErrorMessage(error.cause, failure.fallback),
          retry: () => void attempt(kind === "stage" ? stillUnstaged(cwd, paths) : paths),
        });
      };
      await attempt(scope);
    },
    [worktreePath, refresh, setActionError, debouncedBgRefreshRef, isShowing, stillUnstaged]
  );

  const handleStageFile = useCallback(
    async (filePath: string) => {
      const attempt = async (): Promise<void> => {
        setActionError(null);
        debouncedBgRefreshRef.current?.cancel();
        try {
          await window.electron.git.stageFile(worktreePath, filePath);
          await refresh();
        } catch (err) {
          setActionError({
            title: "Couldn't stage file",
            detail: formatErrorMessage(err, "Failed to stage file"),
            retry: () => void attempt(),
          });
        }
      };
      await attempt();
    },
    [worktreePath, refresh, setActionError, debouncedBgRefreshRef]
  );

  const handleUnstageFile = useCallback(
    async (filePath: string) => {
      const attempt = async (): Promise<void> => {
        setActionError(null);
        debouncedBgRefreshRef.current?.cancel();
        try {
          await window.electron.git.unstageFile(worktreePath, filePath);
          await refresh();
        } catch (err) {
          setActionError({
            title: "Couldn't unstage file",
            detail: formatErrorMessage(err, "Failed to unstage file"),
            retry: () => void attempt(),
          });
        }
      };
      await attempt();
    },
    [worktreePath, refresh, setActionError, debouncedBgRefreshRef]
  );

  const handleStageAll = useCallback(async () => {
    const attempt = async (): Promise<void> => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.stageAll(worktreePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't stage all files",
          detail: formatErrorMessage(err, "Failed to stage all files"),
          retry: () => void attempt(),
        });
      }
    };
    await attempt();
  }, [worktreePath, refresh, setActionError, debouncedBgRefreshRef]);

  const handleUnstageAll = useCallback(async () => {
    const attempt = async (): Promise<void> => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.unstageAll(worktreePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't unstage all files",
          detail: formatErrorMessage(err, "Failed to unstage all files"),
          retry: () => void attempt(),
        });
      }
    };
    await attempt();
  }, [worktreePath, refresh, setActionError, debouncedBgRefreshRef]);

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
    if (isBulkStagingRef.current) return;
    if (selectionSection !== "unstaged" || selectedPaths.size === 0) return;
    isBulkStagingRef.current = true;
    const paths = Array.from(selectedPaths);
    const cwd = worktreePath;
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.stageFiles(cwd, paths);
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      await refresh();
    } catch (err) {
      if (!isShowing(cwd)) return;
      // Part of a large selection may have landed before the failure.
      await refresh();
      if (!isShowing(cwd)) return;
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
      isBulkStagingRef.current = false;
    }
  }, [
    worktreePath,
    refresh,
    selectedPaths,
    selectionSection,
    setActionError,
    setSelectedPaths,
    setSelectionSection,
    selectionAnchorRef,
    debouncedBgRefreshRef,
    isShowing,
    stillUnstaged,
    writePaths,
  ]);

  const handleUnstageSelection = useCallback(async () => {
    if (isBulkStagingRef.current) return;
    if (selectionSection !== "staged" || selectedPaths.size === 0) return;
    isBulkStagingRef.current = true;
    const paths = Array.from(selectedPaths);
    const cwd = worktreePath;
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.unstageFiles(cwd, paths);
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      await refresh();
    } catch (err) {
      if (!isShowing(cwd)) return;
      // Part of a large selection may have landed before the failure.
      await refresh();
      if (!isShowing(cwd)) return;
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
      isBulkStagingRef.current = false;
    }
  }, [
    worktreePath,
    refresh,
    selectedPaths,
    selectionSection,
    setActionError,
    setSelectedPaths,
    setSelectionSection,
    selectionAnchorRef,
    debouncedBgRefreshRef,
    isShowing,
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

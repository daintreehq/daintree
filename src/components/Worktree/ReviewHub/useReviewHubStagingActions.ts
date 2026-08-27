import { useCallback, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { StagingFileEntry } from "@shared/types";
import type { debounce } from "@/utils/debounce";
import { formatErrorMessage } from "@shared/utils/errorMessage";
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
}

interface UseReviewHubStagingActionsArgs {
  worktreePath: string;
  refresh: () => Promise<void>;
  derivedStaged: StagingFileEntry[];
  derivedUnstaged: StagingFileEntry[];
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
  selectedPaths,
  selectionSection,
  setActionError,
  setSelectedPaths,
  setSelectionSection,
  selectionAnchorRef,
  debouncedBgRefreshRef,
}: UseReviewHubStagingActionsArgs): UseReviewHubStagingActionsReturn {
  const isBulkStagingRef = useRef(false);

  const handleStageFile = useCallback(
    async (filePath: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.stageFile(worktreePath, filePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't stage file",
          detail: formatErrorMessage(err, "Failed to stage file"),
        });
      }
    },
    [worktreePath, refresh, setActionError, debouncedBgRefreshRef]
  );

  const handleUnstageFile = useCallback(
    async (filePath: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.unstageFile(worktreePath, filePath);
        await refresh();
      } catch (err) {
        setActionError({
          title: "Couldn't unstage file",
          detail: formatErrorMessage(err, "Failed to unstage file"),
        });
      }
    },
    [worktreePath, refresh, setActionError, debouncedBgRefreshRef]
  );

  const handleStageAll = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.stageAll(worktreePath);
      await refresh();
    } catch (err) {
      setActionError({
        title: "Couldn't stage all files",
        detail: formatErrorMessage(err, "Failed to stage all files"),
      });
    }
  }, [worktreePath, refresh, setActionError, debouncedBgRefreshRef]);

  const handleUnstageAll = useCallback(async () => {
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.unstageAll(worktreePath);
      await refresh();
    } catch (err) {
      setActionError({
        title: "Couldn't unstage all files",
        detail: formatErrorMessage(err, "Failed to unstage all files"),
      });
    }
  }, [worktreePath, refresh, setActionError, debouncedBgRefreshRef]);

  const handleStageFiltered = useCallback(async () => {
    const paths = derivedUnstaged.map((f) => f.path);
    if (paths.length === 0) return;
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.stageFiles(worktreePath, paths);
    } catch (err) {
      setActionError({
        title: "Couldn't stage files",
        detail: formatErrorMessage(err, "Failed to stage files"),
      });
    } finally {
      await refresh();
    }
  }, [worktreePath, refresh, derivedUnstaged, setActionError, debouncedBgRefreshRef]);

  const handleUnstageFiltered = useCallback(async () => {
    const paths = derivedStaged.map((f) => f.path);
    if (paths.length === 0) return;
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.unstageFiles(worktreePath, paths);
    } catch (err) {
      setActionError({
        title: "Couldn't unstage files",
        detail: formatErrorMessage(err, "Failed to unstage files"),
      });
    } finally {
      await refresh();
    }
  }, [worktreePath, refresh, derivedStaged, setActionError, debouncedBgRefreshRef]);

  const handleStageSelection = useCallback(async () => {
    if (isBulkStagingRef.current) return;
    if (selectionSection !== "unstaged" || selectedPaths.size === 0) return;
    isBulkStagingRef.current = true;
    const paths = Array.from(selectedPaths);
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.stageFiles(worktreePath, paths);
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      await refresh();
    } catch (err) {
      setActionError({
        title: "Couldn't stage selected files",
        detail: formatErrorMessage(err, "Failed to stage selected files"),
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
  ]);

  const handleUnstageSelection = useCallback(async () => {
    if (isBulkStagingRef.current) return;
    if (selectionSection !== "staged" || selectedPaths.size === 0) return;
    isBulkStagingRef.current = true;
    const paths = Array.from(selectedPaths);
    setActionError(null);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.unstageFiles(worktreePath, paths);
      setSelectedPaths(new Set());
      setSelectionSection(null);
      selectionAnchorRef.current = null;
      await refresh();
    } catch (err) {
      setActionError({
        title: "Couldn't unstage selected files",
        detail: formatErrorMessage(err, "Failed to unstage selected files"),
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

import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface UseReviewHubBaseBranchArgs {
  worktreePath: string;
  mainBranch: string;
  currentBranch: string | undefined;
  setSelectedBaseBranchFile: Dispatch<SetStateAction<CrossWorktreeFile | null>>;
}

/**
 * The base-branch comparison read, guarded by its own request generation so a
 * comparison that lands after the hub moved on (closed, switched worktree, or
 * fell back to working-tree mode) is dropped.
 */
export function useReviewHubBaseBranch({
  worktreePath,
  mainBranch,
  currentBranch,
  setSelectedBaseBranchFile,
}: UseReviewHubBaseBranchArgs) {
  const [baseBranchFiles, setBaseBranchFiles] = useState<CrossWorktreeFile[] | null>(null);
  const [baseBranchLoading, setBaseBranchLoading] = useState(false);
  const [baseBranchError, setBaseBranchError] = useState<string | null>(null);
  const baseBranchRequestRef = useRef(0);

  const fetchBaseBranch = useCallback(async () => {
    if (!currentBranch || !worktreePath) return;
    if (currentBranch === mainBranch) return;

    const requestId = ++baseBranchRequestRef.current;
    setBaseBranchLoading(true);
    setBaseBranchError(null);
    setBaseBranchFiles(null);
    setSelectedBaseBranchFile(null);

    try {
      const res = await window.electron.git.compareWorktrees(
        worktreePath,
        mainBranch,
        currentBranch,
        undefined,
        true
      );
      if (baseBranchRequestRef.current !== requestId) return;
      if (typeof res === "string") {
        setBaseBranchError("Unexpected result from comparison");
        return;
      }
      setBaseBranchFiles(res.files);
    } catch (err) {
      if (baseBranchRequestRef.current !== requestId) return;
      setBaseBranchError(formatErrorMessage(err, "Failed to load base branch diff"));
    } finally {
      if (baseBranchRequestRef.current === requestId) setBaseBranchLoading(false);
    }
  }, [worktreePath, mainBranch, currentBranch, setSelectedBaseBranchFile]);

  const invalidate = useCallback(() => {
    baseBranchRequestRef.current++;
    setBaseBranchFiles(null);
    setBaseBranchError(null);
  }, []);

  // `invalidate` plus the loading flag: the abandoned request's `finally` no
  // longer clears it, and a stranded `true` deadlocks the next fetch.
  const reset = useCallback(() => {
    invalidate();
    setBaseBranchLoading(false);
  }, [invalidate]);

  return {
    baseBranchFiles,
    baseBranchLoading,
    baseBranchError,
    fetchBaseBranch,
    invalidate,
    reset,
  };
}

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface UseReviewHubBaseBranchArgs {
  worktreePath: string;
  mainBranch: string;
  currentBranch: string | null | undefined;
  /**
   * The commits the two branches were last seen at, as one key. Any move of
   * either tip (a commit, rebase, merge, reset or pull) changes it.
   */
  heads: string;
  /** The comparison is on screen: the hub is open in base-branch mode. */
  active: boolean;
  setSelectedBaseBranchFile: Dispatch<SetStateAction<CrossWorktreeFile | null>>;
}

interface AskedFor {
  comparison: string;
  heads: string;
}

/**
 * The base-branch comparison read, guarded by its own request generation so a
 * comparison that lands after the hub moved on (closed, switched worktree, or
 * fell back to working-tree mode) is dropped.
 *
 * The answer is held for the branches and tips it was asked about (#17196).
 * While it is on screen, a tip moving refreshes it behind the list, keeping
 * the open file; a different branch or base asks again from scratch. Off
 * screen, either one drops it, so coming back asks again.
 */
export function useReviewHubBaseBranch({
  worktreePath,
  mainBranch,
  currentBranch,
  heads,
  active,
  setSelectedBaseBranchFile,
}: UseReviewHubBaseBranchArgs) {
  const [baseBranchFiles, setBaseBranchFiles] = useState<CrossWorktreeFile[] | null>(null);
  const [baseBranchLoading, setBaseBranchLoading] = useState(false);
  const [baseBranchRefreshing, setBaseBranchRefreshing] = useState(false);
  const [baseBranchError, setBaseBranchError] = useState<string | null>(null);
  const baseBranchRequestRef = useRef(0);
  // What the answer held, or the request still out, was asked about.
  const askedForRef = useRef<AskedFor | null>(null);
  // Bumped by the hub's own commits and pulls, which land before the worktree
  // store hears of the new tip.
  const [headMoves, setHeadMoves] = useState(0);
  const pathRef = useRef(worktreePath);
  useLayoutEffect(() => {
    pathRef.current = worktreePath;
  }, [worktreePath]);

  const comparable = !!worktreePath && !!currentBranch && currentBranch !== mainBranch;
  const comparison = JSON.stringify([worktreePath, mainBranch, currentBranch ?? null]);
  const headsKey = `${heads}#${headMoves}`;

  const compare = useCallback(
    async (behindList: boolean) => {
      if (!currentBranch || !worktreePath) return;
      if (currentBranch === mainBranch) return;

      const requestId = ++baseBranchRequestRef.current;
      askedForRef.current = { comparison, heads: headsKey };
      if (behindList) {
        setBaseBranchRefreshing(true);
      } else {
        setBaseBranchLoading(true);
        setBaseBranchRefreshing(false);
        setBaseBranchError(null);
        setBaseBranchFiles(null);
        setSelectedBaseBranchFile(null);
      }

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
        setBaseBranchError(null);
        setBaseBranchFiles(res.files);
      } catch (err) {
        if (baseBranchRequestRef.current !== requestId) return;
        setBaseBranchError(formatErrorMessage(err, "Failed to load base branch diff"));
      } finally {
        if (baseBranchRequestRef.current === requestId) {
          setBaseBranchLoading(false);
          setBaseBranchRefreshing(false);
        }
      }
    },
    [worktreePath, mainBranch, currentBranch, comparison, headsKey, setSelectedBaseBranchFile]
  );

  const fetchBaseBranch = useCallback(() => compare(false), [compare]);

  // Also clears the flags: the abandoned request's `finally` no longer will,
  // and a stranded loading flag deadlocks the next fetch.
  const invalidate = useCallback(() => {
    baseBranchRequestRef.current++;
    askedForRef.current = null;
    setBaseBranchFiles(null);
    setBaseBranchError(null);
    setBaseBranchLoading(false);
    setBaseBranchRefreshing(false);
  }, []);

  const notifyHeadMoved = useCallback((path: string) => {
    if (path === pathRef.current) setHeadMoves((moves) => moves + 1);
  }, []);

  const sync = useEffectEvent(() => {
    if (!comparable) {
      // Detached or on the base itself: what is held, or still out, describes
      // a branch no longer checked out.
      if (askedForRef.current) invalidate();
      return;
    }
    const asked = askedForRef.current;
    const sameComparison = asked?.comparison === comparison;
    const current = sameComparison && asked?.heads === headsKey;
    if (!active) {
      if (asked && !current) invalidate();
      return;
    }
    if (current) {
      // Coming back to a comparison that failed asks again; a held or pending
      // answer stands.
      if (baseBranchError !== null && !baseBranchLoading && !baseBranchRefreshing) {
        void compare(baseBranchFiles !== null);
      }
      return;
    }
    void compare(sameComparison && baseBranchFiles !== null);
  });

  useEffect(() => {
    sync();
  }, [active, comparable, comparison, headsKey]);

  return {
    baseBranchFiles,
    baseBranchLoading,
    baseBranchRefreshing,
    baseBranchError,
    fetchBaseBranch,
    invalidate,
    notifyHeadMoved,
  };
}

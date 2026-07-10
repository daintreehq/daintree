import { useEffect, useCallback, useState, useRef } from "react";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { FileViewerModal } from "@/components/FileViewer/FileViewerModal";
import type { DiffChangeSetEntry } from "@/components/FileViewer/diffChangeSet";
import { useBranchForPath } from "@/hooks/useBranchForPath";
import { usePreferencesStore } from "@/store/preferencesStore";

interface BaseBranchDiffModalProps {
  isOpen: boolean;
  filePath: string;
  worktreePath: string;
  mainBranch: string;
  currentBranch: string;
  onClose: () => void;
  /** Element to focus when the dialog closes and its trigger was unmounted. */
  restoreFocusTo?: RestoreFocusTarget;
  /** Zero-based position of the current file within the navigable set. */
  currentFileIndex?: number;
  /** Total number of files the user can step through. */
  totalFileCount?: number;
  /** Step to the previous (-1) or next (1) file in the set. */
  onNavigateFile?: (delta: -1 | 1) => void;
  /** Full changeset (indexed like `currentFileIndex`) — enables the review workspace. */
  changeSet?: DiffChangeSetEntry[];
  /** Jump directly to a file in `changeSet`. */
  onSelectFile?: (index: number) => void;
}

export function BaseBranchDiffModal({
  isOpen,
  filePath,
  worktreePath,
  mainBranch,
  currentBranch,
  onClose,
  restoreFocusTo,
  currentFileIndex,
  totalFileCount,
  onNavigateFile,
  changeSet,
  onSelectFile,
}: BaseBranchDiffModalProps) {
  const [diff, setDiff] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);
  const branch = useBranchForPath(worktreePath);
  const ignoreWhitespace = usePreferencesStore((s) => s.diffIgnoreWhitespace);

  const absoluteFilePath = worktreePath.endsWith("/")
    ? worktreePath + filePath
    : worktreePath + "/" + filePath;

  const fetchDiff = useCallback(async () => {
    const requestId = ++requestRef.current;
    setDiff(undefined);
    try {
      const result = await window.electron.git.compareWorktrees(
        worktreePath,
        mainBranch,
        currentBranch,
        filePath,
        true,
        ignoreWhitespace
      );
      if (requestRef.current !== requestId) return;
      if (typeof result === "string") {
        setDiff(result || "NO_CHANGES");
      } else {
        setDiff("ERROR");
      }
    } catch {
      if (requestRef.current !== requestId) return;
      setDiff("ERROR");
    }
  }, [worktreePath, mainBranch, currentBranch, filePath, ignoreWhitespace]);

  useEffect(() => {
    if (!isOpen) {
      setDiff(undefined);
      requestRef.current++;
      return;
    }
    fetchDiff();
  }, [isOpen, fetchDiff]);

  return (
    <FileViewerModal
      isOpen={isOpen}
      filePath={absoluteFilePath}
      rootPath={worktreePath}
      branch={branch}
      diff={diff}
      defaultMode="diff"
      onRetryDiff={fetchDiff}
      onClose={onClose}
      restoreFocusTo={restoreFocusTo}
      currentFileIndex={currentFileIndex}
      totalFileCount={totalFileCount}
      onNavigateFile={onNavigateFile}
      changeSet={changeSet}
      onSelectFile={onSelectFile}
    />
  );
}

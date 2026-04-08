import { useEffect, useCallback, useState, useRef } from "react";
import { FileViewerModal } from "@/components/FileViewer/FileViewerModal";
import { useBranchForPath } from "@/hooks/useBranchForPath";

interface BaseBranchDiffModalProps {
  isOpen: boolean;
  filePath: string;
  worktreePath: string;
  mainBranch: string;
  currentBranch: string;
  onClose: () => void;
}

export function BaseBranchDiffModal({
  isOpen,
  filePath,
  worktreePath,
  mainBranch,
  currentBranch,
  onClose,
}: BaseBranchDiffModalProps) {
  const [diff, setDiff] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);
  const branch = useBranchForPath(worktreePath);

  const absoluteFilePath = worktreePath.endsWith("/")
    ? worktreePath + filePath
    : worktreePath + "/" + filePath;

  const fetchDiff = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await window.electron.git.compareWorktrees(
        worktreePath,
        mainBranch,
        currentBranch,
        filePath,
        true
      );
      if (requestRef.current !== requestId) return;
      if (typeof result === "string") {
        setDiff(result || "NO_CHANGES");
      } else {
        setDiff("NO_CHANGES");
      }
    } catch {
      if (requestRef.current !== requestId) return;
      setDiff("NO_CHANGES");
    }
  }, [worktreePath, mainBranch, currentBranch, filePath]);

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
      onClose={onClose}
    />
  );
}

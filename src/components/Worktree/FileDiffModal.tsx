import { useEffect, useCallback, useState, useRef } from "react";
import type { GitStatus } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { FileViewerModal } from "@/components/FileViewer/FileViewerModal";
import { useBranchForPath } from "@/hooks/useBranchForPath";

export interface FileDiffModalProps {
  isOpen: boolean;
  filePath: string;
  status: GitStatus;
  worktreePath: string;
  onClose: () => void;
}

export function FileDiffModal({
  isOpen,
  filePath,
  status,
  worktreePath,
  onClose,
}: FileDiffModalProps) {
  const [diff, setDiff] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);
  const branch = useBranchForPath(worktreePath);

  const absoluteFilePath = worktreePath.endsWith("/")
    ? worktreePath + filePath
    : worktreePath + "/" + filePath;

  const fetchDiff = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await actionService.dispatch(
        "git.getFileDiff",
        { cwd: worktreePath, filePath, status },
        { source: "user" }
      );
      if (requestRef.current !== requestId) return;
      if (!result.ok) {
        setDiff("NO_CHANGES");
        return;
      }
      const diffResult = result.result as string;
      setDiff(diffResult || "NO_CHANGES");
    } catch {
      if (requestRef.current !== requestId) return;
      setDiff("NO_CHANGES");
    }
  }, [worktreePath, filePath, status]);

  useEffect(() => {
    if (!isOpen) {
      setDiff(undefined);
      requestRef.current = 0;
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

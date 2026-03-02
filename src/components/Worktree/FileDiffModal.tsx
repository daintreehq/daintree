import { useEffect, useCallback, useState, useRef } from "react";
import type { GitStatus } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { FileViewerModal } from "@/components/FileViewer/FileViewerModal";

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
      if (!result.ok) return;
      const diffResult = result.result as string;
      setDiff(diffResult || "NO_CHANGES");
    } catch {
      // Fall through — FileViewerModal shows file in View mode
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
      diff={diff}
      defaultMode="diff"
      onClose={onClose}
    />
  );
}

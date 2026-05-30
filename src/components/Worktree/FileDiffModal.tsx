import { Suspense, lazy, useEffect, useCallback, useState, useRef } from "react";
import type { GitStatus } from "@shared/types";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { actionService } from "@/services/ActionService";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useBranchForPath } from "@/hooks/useBranchForPath";

// Lazy boundary cutting the static edge to `react-diff-view` + `refractor`
// (vendor-editor chunk). `FileChangeList` mounts `FileDiffModal` on the
// sidebar's first-paint path, so without this seam the diff viewer would
// land in the eager closure even when no file is open. The chunk is also
// pre-warmed after first paint via `App.tsx`'s post-paint preload block.
const LazyFileViewerModal = lazy(() =>
  import("@/components/FileViewer/FileViewerModal").then((m) => ({
    default: m.FileViewerModal,
  }))
);

// Fallback only renders bones while the modal is actually open. When closed
// the underlying `AppDialog` returns null anyway, so a null fallback keeps
// the sidebar from flashing a skeleton on every mount before the chunk warms.
function FileViewerModalFallback({ isOpen }: { isOpen: boolean }) {
  if (!isOpen) return null;
  return (
    <Skeleton
      label="Loading file viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-medium"
    >
      <SkeletonBone className="w-[min(80vw,720px)] h-[min(70vh,480px)]" />
    </Skeleton>
  );
}

export interface FileDiffModalProps {
  isOpen: boolean;
  filePath: string;
  status: GitStatus;
  worktreePath: string;
  onClose: () => void;
  /** Element to focus when the dialog closes and its trigger was unmounted. */
  restoreFocusTo?: RestoreFocusTarget;
  /** Zero-based position of the current file within the navigable set. */
  currentFileIndex?: number;
  /** Total number of files the user can step through. */
  totalFileCount?: number;
  /** Step to the previous (-1) or next (1) file in the set. */
  onNavigateFile?: (delta: -1 | 1) => void;
}

export function FileDiffModal({
  isOpen,
  filePath,
  status,
  worktreePath,
  onClose,
  restoreFocusTo,
  currentFileIndex,
  totalFileCount,
  onNavigateFile,
}: FileDiffModalProps) {
  const [diff, setDiff] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);
  const branch = useBranchForPath(worktreePath);

  const absoluteFilePath = worktreePath.endsWith("/")
    ? worktreePath + filePath
    : worktreePath + "/" + filePath;

  const fetchDiff = useCallback(async () => {
    const requestId = ++requestRef.current;
    setDiff(undefined);
    try {
      const result = await actionService.dispatch<{ content: string }>(
        "git.getFileDiff",
        { cwd: worktreePath, filePath, status },
        { source: "user" }
      );
      if (requestRef.current !== requestId) return;
      if (!result.ok) {
        setDiff("ERROR");
        return;
      }
      setDiff(result.result.content || "NO_CHANGES");
    } catch {
      if (requestRef.current !== requestId) return;
      setDiff("ERROR");
    }
  }, [worktreePath, filePath, status]);

  useEffect(() => {
    if (!isOpen) {
      setDiff(undefined);
      requestRef.current++;
      return;
    }

    void fetchDiff();
  }, [isOpen, fetchDiff]);

  return (
    <Suspense fallback={<FileViewerModalFallback isOpen={isOpen} />}>
      <LazyFileViewerModal
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
      />
    </Suspense>
  );
}

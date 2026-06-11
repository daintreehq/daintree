import { Suspense, lazy, useEffect, useCallback, useState, useRef } from "react";
import type { GitStatus } from "@shared/types";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { actionService } from "@/services/ActionService";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useBranchForPath } from "@/hooks/useBranchForPath";
import { usePreferencesStore } from "@/store/preferencesStore";

// Session-scoped LRU so stepping back and forth through a change set doesn't
// re-pay git spawn + IPC + parse for files already viewed (and doesn't burn
// the shared gitOps rate-limit budget). Cleared whenever a diff modal closes,
// which bounds staleness to a single review session.
const DIFF_CACHE_MAX = 20;
const diffCache = new Map<string, string>();

export function _resetDiffCacheForTests(): void {
  diffCache.clear();
}

function cacheDiff(key: string, value: string): void {
  diffCache.delete(key);
  diffCache.set(key, value);
  if (diffCache.size > DIFF_CACHE_MAX) {
    const oldest = diffCache.keys().next().value;
    if (oldest !== undefined) diffCache.delete(oldest);
  }
}

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
  const ignoreWhitespace = usePreferencesStore((s) => s.diffIgnoreWhitespace);

  // Toggling ignore-whitespace strands every entry built under the other flag
  // (their keys can no longer be requested this session unless the user
  // toggles back, and a long review can hold 20 stale diffs). Purge them.
  useEffect(() => {
    for (const key of [...diffCache.keys()]) {
      if (!key.endsWith(`\u0000${ignoreWhitespace}`)) diffCache.delete(key);
    }
  }, [ignoreWhitespace]);

  const absoluteFilePath = worktreePath.endsWith("/")
    ? worktreePath + filePath
    : worktreePath + "/" + filePath;

  const fetchDiff = useCallback(
    async (bypassCache = false) => {
      const cacheKey = `${worktreePath}\u0000${filePath}\u0000${status}\u0000${ignoreWhitespace}`;
      const requestId = ++requestRef.current;
      if (!bypassCache) {
        const cached = diffCache.get(cacheKey);
        if (cached !== undefined) {
          setDiff(cached);
          return;
        }
      }
      setDiff(undefined);
      try {
        const result = await actionService.dispatch<{ content: string }>(
          "git.getFileDiff",
          { cwd: worktreePath, filePath, status, ignoreWhitespace },
          { source: "user" }
        );
        if (requestRef.current !== requestId) return;
        if (!result.ok) {
          setDiff("ERROR");
          return;
        }
        const content = result.result.content || "NO_CHANGES";
        cacheDiff(cacheKey, content);
        setDiff(content);
      } catch {
        if (requestRef.current !== requestId) return;
        setDiff("ERROR");
      }
    },
    [worktreePath, filePath, status, ignoreWhitespace]
  );

  const handleRetry = useCallback(() => {
    void fetchDiff(true);
  }, [fetchDiff]);

  useEffect(() => {
    if (!isOpen) {
      setDiff(undefined);
      requestRef.current++;
      diffCache.clear();
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
        diffMatchesFile
        onRetryDiff={handleRetry}
        onClose={onClose}
        restoreFocusTo={restoreFocusTo}
        currentFileIndex={currentFileIndex}
        totalFileCount={totalFileCount}
        onNavigateFile={onNavigateFile}
      />
    </Suspense>
  );
}

import { Suspense, lazy, useEffect, useCallback, useState, useRef } from "react";
import type { GitStatus } from "@shared/types";
import type { DiffChangeSetEntry } from "@/components/FileViewer/diffChangeSet";
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
const PREFETCH_DWELL_MS = 500;
const diffCache = new Map<string, string>();
const inflightDiffRequests = new Map<string, Promise<string | null>>();
let diffCacheGeneration = 0;

export function _resetDiffCacheForTests(): void {
  diffCache.clear();
  inflightDiffRequests.clear();
  diffCacheGeneration++;
}

function diffCacheKey(
  worktreePath: string,
  filePath: string,
  status: GitStatus,
  ignoreWhitespace: boolean
): string {
  return `${worktreePath}\u0000${filePath}\u0000${status}\u0000${ignoreWhitespace}`;
}

function cacheDiff(key: string, value: string): void {
  diffCache.delete(key);
  diffCache.set(key, value);
  if (diffCache.size > DIFF_CACHE_MAX) {
    const oldest = diffCache.keys().next().value;
    if (oldest !== undefined) diffCache.delete(oldest);
  }
}

// Single fetch path shared by the foreground load and the next-file prefetch:
// cache hits resolve without dispatching and in-flight requests are deduped so
// the two never double-spend the shared gitOps rate-limit budget on one key.
// The generation guard keeps a request resolving after the modal closed (and
// cleared the cache) from seeding the next session with a stale entry.
function requestDiff(
  worktreePath: string,
  filePath: string,
  status: GitStatus,
  ignoreWhitespace: boolean,
  bypassCache = false
): Promise<string | null> {
  const key = diffCacheKey(worktreePath, filePath, status, ignoreWhitespace);
  if (!bypassCache) {
    const cached = diffCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = inflightDiffRequests.get(key);
    if (inflight) return inflight;
  }
  const generation = diffCacheGeneration;
  const request = actionService
    .dispatch<{ content: string }>(
      "git.getFileDiff",
      { cwd: worktreePath, filePath, status, ignoreWhitespace },
      { source: "user" }
    )
    .then((result) => {
      if (!result.ok) return null;
      const content = result.result.content || "NO_CHANGES";
      if (generation === diffCacheGeneration) cacheDiff(key, content);
      return content;
    })
    .finally(() => {
      if (inflightDiffRequests.get(key) === request) inflightDiffRequests.delete(key);
    });
  inflightDiffRequests.set(key, request);
  return request;
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
  /** Resolve the neighboring file in the set, for prefetching its diff. */
  getAdjacentFile?: (delta: -1 | 1) => { path: string; status: GitStatus } | null;
  /** Full changeset (indexed like `currentFileIndex`) — enables the review workspace. */
  changeSet?: DiffChangeSetEntry[];
  /** Jump directly to a file in `changeSet`. */
  onSelectFile?: (index: number) => void;
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
  getAdjacentFile,
  changeSet,
  onSelectFile,
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
      const cacheKey = diffCacheKey(worktreePath, filePath, status, ignoreWhitespace);
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
        const content = await requestDiff(
          worktreePath,
          filePath,
          status,
          ignoreWhitespace,
          bypassCache
        );
        if (requestRef.current !== requestId) return;
        setDiff(content ?? "ERROR");
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
      diffCacheGeneration++;
      return;
    }

    void fetchDiff();
  }, [isOpen, fetchDiff]);

  // Once the current diff has landed and the user has dwelled on it, warm the
  // next file's diff so forward stepping renders from cache instead of a
  // skeleton. The dwell timer keeps rapid scrubbing from bursting requests
  // against the shared gitOps rate limit; failures are silently dropped — the
  // foreground fetch will retry and surface its own error.
  useEffect(() => {
    if (!isOpen || !getAdjacentFile || diff === undefined || diff === "ERROR") return;
    const timer = window.setTimeout(() => {
      const next = getAdjacentFile(1);
      if (!next) return;
      void requestDiff(worktreePath, next.path, next.status, ignoreWhitespace).catch(
        () => undefined
      );
    }, PREFETCH_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, diff, getAdjacentFile, worktreePath, ignoreWhitespace]);

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
        changeSet={changeSet}
        onSelectFile={onSelectFile}
        fileStatus={status}
      />
    </Suspense>
  );
}

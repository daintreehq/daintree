import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Spinner } from "@/components/ui/Spinner";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";

const COMMIT_LIMIT = 12;
const SHORT_HASH_LEN = 7;

interface RebasePreviewCommit {
  hash: string;
  message: string;
  author: string;
}

/**
 * D1 confirm for the `git.pullRebase` action dispatched outside the ReviewHub
 * (palette, keybinding, terminal push-error recovery banner) (#8242). Reads
 * the pending request from `gitPullRebaseConfirmStore`, previews the local
 * commits a rebase would replay, and resolves the deferred Promise the action
 * `run()` is awaiting.
 */
function GitPullRebaseConfirmDialogInner() {
  const pendingConfirm = useGitPullRebaseConfirmStore((s) => s.pendingConfirm);
  const resolveConfirmation = useGitPullRebaseConfirmStore((s) => s.resolveConfirmation);

  const cwd = pendingConfirm?.cwd ?? null;

  const [branch, setBranch] = useState<string | null>(null);
  const [commits, setCommits] = useState<RebasePreviewCommit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);

  const loadPreview = useCallback(() => {
    if (!cwd) return;
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setBranch(null);
    setCommits(null);

    safeFireAndForget(
      Promise.all([
        window.electron.git.getStagingStatus(cwd),
        window.electron.git.listCommits({ cwd, limit: COMMIT_LIMIT }),
      ])
        .then(([status, commitList]) => {
          if (requestIdRef.current !== requestId) return;
          setBranch(status.currentBranch);
          setCommits(
            commitList.items.map((c) => ({
              hash: c.hash,
              message: c.message,
              author: c.author.name,
            }))
          );
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          setLoadError(formatErrorMessage(err, "Failed to load rebase preview"));
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        }),
      { context: "GitPullRebaseConfirmDialog: load rebase preview" }
    );
  }, [cwd]);

  useEffect(() => {
    if (!cwd) {
      setBranch(null);
      setCommits(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    loadPreview();
  }, [cwd, loadPreview]);

  // Resolve false on unmount to prevent a leaked awaited Promise.
  useEffect(() => {
    return () => {
      if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
        useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const branchLabel = branch ?? "current branch";

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveConfirmation(false)}
      title={`Pull and rebase '${branchLabel}'?`}
      description={
        <span>
          Pulls the remote and replays your local commits on{" "}
          <span className="font-mono">{branchLabel}</span> on top of it. Rebasing rewrites local
          commit history and cannot be undone.
        </span>
      }
      confirmLabel="Pull and rebase"
      cancelLabel="Cancel"
      variant="destructive"
      isConfirmLoading={isLoading}
      onConfirm={() => resolveConfirmation(true)}
    >
      <div className="rounded border border-tint/[0.08] bg-tint/[0.04]">
        <div className="px-3 py-2 border-b border-tint/[0.08]">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
            Local commits to replay
          </span>
        </div>

        {isLoading && (
          <div
            className="flex items-center justify-center py-6"
            data-testid="git-pull-rebase-commits-loading"
          >
            <Spinner size="sm" className="text-daintree-text/40" />
          </div>
        )}

        {!isLoading && loadError && (
          <div className="px-3 py-3 text-status-error flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div>{loadError}</div>
              <button
                type="button"
                onClick={loadPreview}
                data-testid="git-pull-rebase-commits-retry"
                className={cn(
                  "mt-1 inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  "bg-status-error/15 hover:bg-status-error/25 text-status-error",
                  "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-status-error"
                )}
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {!isLoading && !loadError && commits && commits.length === 0 && (
          <div className="px-3 py-3 text-daintree-text/50">
            No local commits found on this branch.
          </div>
        )}

        {!isLoading && !loadError && commits && commits.length > 0 && (
          <ul className="px-3 py-2 space-y-1.5 max-h-[180px] overflow-y-auto">
            {commits.map((commit) => (
              <li
                key={commit.hash}
                className="flex items-baseline gap-2"
                data-testid="git-pull-rebase-commit-row"
              >
                <span className="font-mono text-[10px] text-daintree-text/40 shrink-0 tabular-nums">
                  {commit.hash.slice(0, SHORT_HASH_LEN)}
                </span>
                <span className="text-daintree-text/80 truncate min-w-0">{commit.message}</span>
                <span className="text-[10px] text-daintree-text/40 shrink-0 ml-auto">
                  {commit.author}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ConfirmDialog>
  );
}

export function GitPullRebaseConfirmDialog() {
  return (
    <ErrorBoundary variant="component" componentName="GitPullRebaseConfirmDialog">
      <GitPullRebaseConfirmDialogInner />
    </ErrorBoundary>
  );
}

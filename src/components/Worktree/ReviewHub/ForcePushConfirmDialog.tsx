import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { Spinner } from "@/components/ui/Spinner";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { GitRemoteCommitPreview } from "@shared/types/git";
import { formatGitPushDestination } from "@/components/Git/gitRemoteOperationPreview";

interface ForcePushConfirmDialogProps {
  isOpen: boolean;
  cwd: string;
  branchName: string;
  leaseSha: string;
  onClose: () => void;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}

const COMMIT_LIMIT = 20;
const SHORT_HASH_LEN = 7;

export function ForcePushConfirmDialog({
  isOpen,
  cwd,
  branchName,
  leaseSha,
  onClose,
  onSuccess,
  onError,
}: ForcePushConfirmDialogProps) {
  const [preview, setPreview] = useState<GitRemoteCommitPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const isExecutingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadCommits = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setLoadError(null);
    setPreview(null);

    safeFireAndForget(
      window.electron.git
        .listRemoteCommits(cwd, branchName, COMMIT_LIMIT)
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setPreview(result);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current !== requestId) return;
          setLoadError(formatErrorMessage(err, "Failed to load remote commits"));
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        }),
      { context: "ForcePushConfirmDialog: load remote commits" }
    );
  }, [cwd, branchName]);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    loadCommits();
  }, [isOpen, loadCommits]);

  const handleConfirm = async () => {
    if (isExecutingRef.current) return;
    if (isLoading) return;
    // Block confirm when the discard preview failed to load — without it the
    // user has no visibility into what `--force-with-lease` would discard,
    // even though the lease itself still keeps the operation safe. `preview`
    // is checked too: on the first render after opening it is null while
    // `isLoading` is still false, so the two guards together are what close
    // the window on a click landing before the fetch starts.
    if (loadError || preview === null) return;
    isExecutingRef.current = true;
    setIsPushing(true);
    try {
      await window.electron.git.forcePushWithLease(cwd, branchName, leaseSha);
      onSuccess();
      useAnnouncerStore.getState().announce(`Force pushed ${branchName}`);
    } catch (err) {
      onError(err);
      useAnnouncerStore.getState().announce(`Couldn't force push ${branchName}`, "assertive");
    } finally {
      isExecutingRef.current = false;
      setIsPushing(false);
    }
  };

  const commits = preview?.commits ?? null;
  // Both the rows and the total come from the same `HEAD..<push ref>` range, so
  // the tail can't be computed against a different repository's ref (#11746).
  const totalRemote = preview?.total ?? 0;
  const hiddenCount =
    commits !== null && totalRemote > commits.length ? totalRemote - commits.length : 0;
  // Optional-chained rather than keyed off `preview` alone: this crosses the
  // IPC boundary, so a payload missing the field must degrade to the branch
  // name rather than throwing inside a destructive confirm.
  const destinationLabel = preview?.destination
    ? formatGitPushDestination(preview.destination)
    : null;

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={destinationLabel ? `Force push to ${destinationLabel}?` : `Force push ${branchName}?`}
      onClose={isPushing ? undefined : onClose}
      onConfirm={() => void handleConfirm()}
      confirmLabel="Force push"
      cancelLabel="Cancel"
      variant="destructive"
      hasPreview={true}
      isConfirmLoading={isPushing}
      confirmDisabled={isLoading || !!loadError || preview === null}
    >
      <div className="space-y-3 text-xs text-daintree-text/80">
        <p>
          This rewrites <span className="font-mono">{destinationLabel ?? branchName}</span> to match
          your local branch <span className="font-mono">{branchName}</span>. Any commits on the
          remote that aren&apos;t in your local history will be discarded.
        </p>

        <div className="rounded border border-tint/[0.08] bg-tint/[0.04]">
          <div className="px-3 py-2 border-b border-tint/[0.08] flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
              Remote commits to discard
              {totalRemote > 0 && (
                <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
                  {totalRemote}
                </span>
              )}
            </span>
          </div>

          {isLoading && (
            <div
              className="flex items-center justify-center py-6"
              data-testid="force-push-commits-loading"
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
                  onClick={loadCommits}
                  data-testid="force-push-commits-retry"
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
              No remote commits to discard. The remote may already match your local branch.
            </div>
          )}

          {!isLoading && !loadError && commits && commits.length > 0 && (
            <ul className="px-3 py-2 space-y-1.5 max-h-[180px] overflow-y-auto">
              {commits.map((commit) => (
                <li
                  key={commit.hash}
                  className="flex items-baseline gap-2"
                  data-testid="force-push-commit-row"
                >
                  <span
                    className={cn(
                      "font-mono text-[10px] text-daintree-text/40 shrink-0 tabular-nums"
                    )}
                  >
                    {commit.hash.slice(0, SHORT_HASH_LEN)}
                  </span>
                  <span className="text-daintree-text/80 truncate min-w-0">{commit.message}</span>
                  <span className="text-[10px] text-daintree-text/40 shrink-0 ml-auto">
                    {commit.author}
                  </span>
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="text-[10px] text-daintree-text/40 italic pt-1">
                  …and {hiddenCount} more
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </ConfirmDialog>
  );
}

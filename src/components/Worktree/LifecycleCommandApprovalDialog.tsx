import { useEffect, useState } from "react";
import type { LifecycleCommandReview } from "@shared/types/worktree";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { worktreeClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Click-carry-over guard, as on `McpConfirmDialog`: the review can land under a
 * pointer that was aimed at the button which opened the dialog.
 */
const APPROVE_COOLDOWN_MS = 1_200;

export interface LifecycleCommandApprovalDialogProps {
  isOpen: boolean;
  worktreeId: string;
  /** The worktree's setup was skipped for approval and runs once this approves. */
  setupAwaitingApproval: boolean;
  onClose: () => void;
}

/**
 * Shows the repository commands a worktree would run and lets the user
 * approve them (#12408). The only way approval is granted: the host re-reads
 * the commands on open, and approval is submitted against the fingerprint of
 * exactly what this dialog displayed, so a change made while it is open is
 * refused rather than approved unseen.
 */
export function LifecycleCommandApprovalDialog({
  isOpen,
  worktreeId,
  setupAwaitingApproval,
  onClose,
}: LifecycleCommandApprovalDialogProps) {
  // `undefined` while loading, `null` when nothing is waiting. The approve
  // button keys off the loaded review itself, never off the dialog being open.
  const [review, setReview] = useState<LifecycleCommandReview | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setReview(undefined);
    setLoadError(null);
    worktreeClient.getLifecycleCommandReview(worktreeId).then(
      (next) => {
        if (!cancelled) setReview(next);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(formatErrorMessage(err, "Couldn't read the commands"));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktreeId, loadCount]);

  useEffect(() => {
    if (!isOpen) setApproveError(null);
  }, [isOpen]);

  const isLoading = isOpen && review === undefined && loadError === null;
  const showSpinner = useDeferredLoading(isLoading, UI_DOHERTY_THRESHOLD);

  const handleApprove = async () => {
    if (!review) return;
    setIsApproving(true);
    setApproveError(null);
    try {
      await worktreeClient.approveLifecycleCommands(worktreeId, review.fingerprint);
      onClose();
    } catch (err) {
      setApproveError(formatErrorMessage(err, "Couldn't approve the commands"));
      // Whatever is on disk now is what the next approval must be about.
      setLoadCount((count) => count + 1);
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      variant="default"
      title="Approve repository commands?"
      description="These commands come from the repository and run with your account when worktrees are set up, torn down, or their resources are managed. Approve them only if you trust whoever wrote them — on a pull request branch, that's its author. Approval covers these exact lines, not the scripts they call, and any change to them asks again."
      confirmLabel={setupAwaitingApproval ? "Approve and run setup" : "Approve commands"}
      cancelLabel={review === null ? "Close" : "Cancel"}
      onConfirm={handleApprove}
      isConfirmLoading={isApproving}
      confirmDisabled={!review}
      confirmCooldownMs={APPROVE_COOLDOWN_MS}
      cooldownKey={review?.fingerprint}
      hasPreview
      bodyResetKey={review?.fingerprint}
    >
      <div className="min-h-[5.5rem] space-y-3">
        {loadError !== null ? (
          <p role="alert" className="text-xs text-status-error">
            {loadError}
          </p>
        ) : review === undefined ? (
          showSpinner ? (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Spinner size="xs" />
              <span>Reading commands…</span>
            </div>
          ) : null
        ) : review === null ? (
          <p className="text-xs text-text-secondary">
            Nothing is waiting for approval — these commands are already approved or are your own.
          </p>
        ) : (
          review.sources.map((source) => (
            <section key={source.path} className="space-y-2">
              <p className="break-all font-mono text-2xs text-text-secondary">{source.path}</p>
              {source.groups.map((group) => (
                <div key={group.label} className="space-y-1">
                  <p className="text-xs font-medium text-text-primary">{group.label}</p>
                  <pre className="max-h-40 overflow-auto rounded-[var(--radius-md)] bg-surface-inset p-2 font-mono text-2xs text-text-primary whitespace-pre-wrap break-all select-text">
                    {group.commands.join("\n")}
                  </pre>
                </div>
              ))}
            </section>
          ))
        )}
        {approveError !== null && (
          <p role="alert" className="text-xs text-status-error">
            {approveError}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

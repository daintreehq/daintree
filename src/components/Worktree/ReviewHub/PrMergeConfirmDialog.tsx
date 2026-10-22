import { useCallback, useEffect, useRef, useState } from "react";
import type { PR } from "@shared/types/forge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import {
  CommitRows,
  PreviewFrame,
  PreviewNote,
  PreviewNotice,
  PreviewSectionHeading,
  PreviewSkeleton,
  PreviewSummary,
  RefChip,
  SummaryRow,
} from "@/components/Git/GitOperationPreview";
import { forgeClient } from "@/clients/forgeClient";
import { worktreeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { describeMergeIntent, mergeMethodLabel } from "@shared/utils/prMergeIntent";
import {
  confirmBlockReason,
  effectiveMergeMode,
  mergeActionLabel,
  type PrMergeMode,
  type PrMergeRequest,
} from "./prMergeModel";

type PreviewState =
  | { kind: "loading" }
  | { kind: "loaded"; pr: PR }
  | { kind: "missing" }
  | { kind: "error"; message: string };

interface PrMergeConfirmDialogProps {
  worktreePath: string;
  prNumber: number;
  /** `null` while closed. */
  request: PrMergeRequest | null;
  onClose: () => void;
  /** Where focus returns on close: the chip, since the popover is gone by then. */
  restoreFocusTo?: RestoreFocusTarget;
}

const SHORT_SHA = 7;
const MODE_COOLDOWN_MS = 600;

/** "owner/repo" from a forge PR URL; the PR's own record names no repository. */
function repositoryFromUrl(url: string): string | null {
  try {
    const [owner, repo] = new URL(url).pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

/**
 * The D2 confirm for the Review Hub's merge control: arm "merge when ready",
 * merge now, or cancel a pending merge. It re-reads the pull request when it
 * opens and previews what that read says will land — repository, base, head
 * commit, the commits and the method — and pins the write to that head.
 *
 * The mode is re-decided from the read, never carried over silently: a PR that
 * turned mergeable since the popover opened is offered as Merge, under a notice
 * saying so, and the user has to confirm that instead. A rejected arm that
 * comes back `already-mergeable` does the same. Nothing here ever falls
 * through to an immediate merge on its own.
 */
export function PrMergeConfirmDialog({
  worktreePath,
  prNumber,
  request,
  onClose,
  restoreFocusTo,
}: PrMergeConfirmDialogProps) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const isOpen = request !== null;

  // Always past the provider's cache: a minute-old read could preview a base
  // the PR has since been retargeted off, and the head pin wouldn't catch it.
  const load = useCallback(() => {
    const generation = (generationRef.current += 1);
    setPreview({ kind: "loading" });
    forgeClient.getPR(worktreePath, prNumber, { fresh: true }).then(
      (pr) => {
        if (generationRef.current !== generation) return;
        setPreview(pr ? { kind: "loaded", pr } : { kind: "missing" });
      },
      (err: unknown) => {
        if (generationRef.current !== generation) return;
        setPreview({
          kind: "error",
          message: formatErrorMessage(err, "The pull request couldn't be read."),
        });
      }
    );
  }, [worktreePath, prNumber]);

  useEffect(() => {
    if (!isOpen) return;
    setBusy(false);
    setError(null);
    load();
    return () => void (generationRef.current += 1);
  }, [isOpen, load]);

  if (!request) return null;

  const pr = preview.kind === "loaded" ? preview.pr : null;
  // Decided by the latest read alone. An arm GitHub declined as already
  // mergeable reloads, and the read then says so — no override that could
  // outlive the state it described.
  const mode: PrMergeMode = pr ? effectiveMergeMode(pr, request.mode) : request.mode;
  const changedMode = mode !== request.mode;
  const queue = pr?.mergeQueueRequired === true;
  const method = queue ? null : request.method;
  const headSha = pr?.headSha ?? null;
  const repository = pr ? repositoryFromUrl(pr.url) : null;
  const commits = pr?.commits;
  const blockReason = pr ? confirmBlockReason(pr, mode, { repository, method }) : null;
  const confirmDisabled = busy || !pr || blockReason !== null;

  const handleConfirm = async () => {
    if (confirmDisabled || !pr) return;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    const target = { worktreePath, prNumber };
    const result =
      mode === "arm"
        ? await actionService.dispatch(
            "forge.enableAutoMerge",
            {
              ...target,
              ...(method ? { mergeMethod: method } : {}),
              expectedHeadSha: headSha!,
              expectedBaseRef: pr.baseRef,
            },
            { source: "user" }
          )
        : mode === "merge"
          ? await actionService.dispatch(
              "forge.mergePR",
              {
                ...target,
                ...(method ? { mergeMethod: method } : {}),
                expectedHeadSha: headSha!,
                expectedBaseRef: pr.baseRef,
              },
              { source: "user" }
            )
          : await actionService.dispatch("forge.disableAutoMerge", target, { source: "user" });
    if (generationRef.current !== generation) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message || "GitHub rejected the request.");
      return;
    }
    const outcome =
      typeof result.result === "object" && result.result !== null && "outcome" in result.result
        ? result.result.outcome
        : undefined;
    if (outcome === "already-mergeable") {
      // Ask again, against a fresh read of what would land now.
      load();
      return;
    }
    // The forge decides what happened; a forced detection pass is what shows it.
    void worktreeClient.refreshPullRequests().catch(() => {});
    onClose();
  };

  const title =
    mode === "cancel"
      ? request.mode === "cancel" && pr?.mergeIntent?.kind === "queued"
        ? `Remove #${prNumber} from the merge queue?`
        : `Cancel auto-merge for #${prNumber}?`
      : mode === "merge"
        ? `Merge #${prNumber}?`
        : `Merge #${prNumber} when ready?`;

  // A merge, now or later, writes into the shared base; cancelling only stops one.
  const variantProps =
    mode === "cancel" ? ({ variant: "default" } as const) : ({ variant: "destructive" } as const);

  const methodText = queue ? "Set by the merge queue" : method ? mergeMethodLabel(method) : "—";

  return (
    <ConfirmDialog
      {...variantProps}
      isOpen={true}
      title={title}
      onClose={onClose}
      onConfirm={handleConfirm}
      confirmLabel={mergeActionLabel(mode, pr?.mergeIntent)}
      cancelLabel={mode === "cancel" ? "Keep it" : "Cancel"}
      hasPreview={true}
      isBusy={busy}
      isConfirmLoading={busy}
      confirmDisabled={confirmDisabled}
      // A mode that changes under the user — arm turned into Merge — earns a
      // fresh read-time gate, so a double-click aimed at the first can't land
      // on the second.
      confirmCooldownMs={MODE_COOLDOWN_MS}
      cooldownKey={mode}
      restoreFocusTo={restoreFocusTo}
      hint={preview.kind === "loading" ? "Reading the pull request…" : blockReason}
    >
      <div className="space-y-3 text-xs text-text-primary">
        {mode === "arm" && (
          <p>
            GitHub merges this pull request into its base once the required checks and reviews pass
            {queue ? ", through the branch's merge queue" : ""}. Daintree doesn&apos;t decide when.
          </p>
        )}
        {mode === "merge" && (
          <p>
            This writes the commits below into the base branch for everyone working from it. It
            can&apos;t be undone.
          </p>
        )}
        {mode === "cancel" && pr?.mergeIntent && (
          <p>{describeMergeIntent(pr.mergeIntent)}. Cancelling stops GitHub merging it.</p>
        )}
        {mode === "cancel" && pr && !pr.mergeIntent && (
          <p>GitHub no longer reports a pending merge for this pull request.</p>
        )}

        <PreviewFrame>
          {changedMode && pr && (
            <PreviewNotice
              tone="warning"
              title={
                mode === "merge"
                  ? "This pull request can merge now"
                  : "This pull request can't merge yet"
              }
              testId="pr-merge-mode-changed"
            >
              {mode === "merge"
                ? "GitHub won't arm auto-merge for it. Confirm to merge it immediately instead."
                : "It changed since the checks were read. Confirm to merge it when ready instead."}
            </PreviewNotice>
          )}
          {error && (
            <PreviewNotice tone="error" title="GitHub rejected the request" testId="pr-merge-error">
              {error}
            </PreviewNotice>
          )}
          {preview.kind === "error" && (
            <PreviewNotice tone="error" title="Couldn't read the pull request" onRetry={load}>
              {preview.message}
            </PreviewNotice>
          )}
          {preview.kind === "missing" && (
            <PreviewNotice
              tone="error"
              title={`Pull request #${prNumber} wasn't found`}
              onRetry={load}
            />
          )}

          {preview.kind === "loading" && (
            <PreviewSkeleton label="Reading the pull request" testId="pr-merge-preview-loading" />
          )}

          {pr && (
            <PreviewSummary testId="pr-merge-summary">
              <SummaryRow label="Repo">
                {repository ? <RefChip value={repository} /> : <span>—</span>}
              </SummaryRow>
              <SummaryRow label="Into">
                <RefChip value={pr.baseRef} data-testid="pr-merge-base" />
              </SummaryRow>
              <SummaryRow label="From">
                <RefChip value={pr.headRef} />
              </SummaryRow>
              {headSha && (
                <SummaryRow label="Head">
                  <span className="font-mono text-text-primary" data-testid="pr-merge-head">
                    {headSha.slice(0, SHORT_SHA)}
                  </span>
                </SummaryRow>
              )}
              {mode !== "cancel" && (
                <SummaryRow label="Method">
                  <span data-testid="pr-merge-method">{methodText}</span>
                </SummaryRow>
              )}
            </PreviewSummary>
          )}

          {pr && mode !== "cancel" && commits && (
            <>
              <PreviewSectionHeading label="Commits" count={commits.totalCount} />
              {commits.items.length > 0 ? (
                <CommitRows
                  commits={commits.items.map((c) => ({
                    hash: c.sha,
                    message: c.subject,
                    author: c.author ?? "",
                  }))}
                  total={commits.totalCount}
                  label={`Commits in pull request #${prNumber}`}
                  rowTestId="pr-merge-commit-row"
                  capTestId="pr-merge-commit-cap"
                />
              ) : (
                <PreviewNote>GitHub listed no commits for this pull request.</PreviewNote>
              )}
            </>
          )}
        </PreviewFrame>

        {mode === "arm" && (
          <p className="text-text-secondary" data-testid="pr-merge-push-warning">
            Arming pins the head above, but only for this request. A later push by anyone with write
            access — including your own agents, which push with your credentials — keeps auto-merge
            armed, and GitHub can then merge commits nobody reviewed here.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

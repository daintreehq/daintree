import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GitPullRequest } from "lucide-react";
import type { PR, PRMergeIntent, PRMergeMethod } from "@shared/types/forge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import {
  Bone,
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
import { useDeferredLoading, useDohertyGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  MERGE_STATUS_UNREPORTED_REASON,
  confirmBlockReason,
  describeMergeRejection,
  effectiveMergeMode,
  mergeActionLabel,
  type PrMergeMode,
  type PrMergeOutcome,
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
  /** What GitHub reported back, handed over before the dialog closes. */
  onComplete?: (outcome: PrMergeOutcome) => void;
  /** Where focus returns on close: the chip, since the popover is gone by then. */
  restoreFocusTo?: RestoreFocusTarget;
}

const SHORT_SHA = 7;
const MODE_COOLDOWN_MS = 600;

const METHOD_LABEL: Record<PRMergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
};

const TECHNICAL_SUMMARY_CLASS =
  "cursor-pointer rounded-[var(--radius-xs)] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary";

/** "owner/repo" from a forge PR URL; the PR's own record names no repository. */
function repositoryFromUrl(url: string): string | null {
  try {
    const [owner, repo] = new URL(url).pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

/** The forge's raw words, kept for whoever needs them and out of everyone else's way. */
function TechnicalDetails({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <details className="mt-1">
      <summary className={TECHNICAL_SUMMARY_CLASS}>Technical details</summary>
      <code className="mt-1 block font-mono text-2xs text-text-secondary break-words whitespace-pre-wrap">
        {text.trim()}
      </code>
    </details>
  );
}

function isMergeIntent(value: unknown): value is PRMergeIntent {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  return kind === "queued" || kind === "auto-merge";
}

function readOutcome(
  mode: PrMergeMode,
  result: unknown,
  context: { baseRef: string; queue: boolean; method: PRMergeMethod | null }
): PrMergeOutcome | "already-mergeable" {
  const record = typeof result === "object" && result !== null ? result : {};
  const field = (key: string): unknown => (key in record ? Reflect.get(record, key) : undefined);
  // Only what the reply says: a merge GitHub didn't report as done, or an arm
  // it didn't describe, is acknowledged as requested and changes no chip.
  if (mode === "merge") {
    return field("merged") === true
      ? { kind: "merged", baseRef: context.baseRef }
      : { kind: "merge-requested", baseRef: context.baseRef };
  }
  if (mode === "arm") {
    if (field("outcome") === "already-mergeable") return "already-mergeable";
    const reported = field("mergeIntent");
    return isMergeIntent(reported)
      ? { kind: "armed", intent: reported }
      : { kind: "arm-requested", queue: context.queue };
  }
  const outcome = field("outcome");
  if (outcome === "dequeued") return { kind: "dequeued" };
  if (outcome === "not-pending") return { kind: "not-pending" };
  return { kind: "disarmed" };
}

/**
 * The D2 confirm for the Review Hub's merge control: enable auto-merge (or
 * hand the PR to a merge queue), merge now, or cancel a pending merge. It
 * re-reads the pull request when it opens and previews what that read says
 * will land — repository, base, head commit, the commits and the method — and
 * pins the write to that head.
 *
 * The mode is re-decided from the read, never carried over silently: a PR that
 * turned mergeable since the popover opened is offered as a merge, under a
 * notice saying so, and the user has to confirm that instead. A rejected arm
 * that comes back `already-mergeable` does the same. Nothing here ever falls
 * through to an immediate merge on its own.
 */
export function PrMergeConfirmDialog({
  worktreePath,
  prNumber,
  request,
  onClose,
  onComplete,
  restoreFocusTo,
}: PrMergeConfirmDialogProps) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  // Bumped whenever the control holding focus is about to disappear — a
  // Retry that turns into a skeleton, a primary locked by a re-read — so
  // focus goes back to the safe control instead of falling to the body.
  const [focusKey, setFocusKey] = useState(0);
  // Each rejected attempt earns the next one a fresh read-time gate.
  const [attempt, setAttempt] = useState(0);
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
        setPreview({ kind: "error", message: formatErrorMessage(err, "") });
      }
    );
  }, [worktreePath, prNumber]);

  useEffect(() => {
    if (!isOpen) return;
    setBusy(false);
    setRejection(null);
    setAttempt(0);
    load();
    return () => void (generationRef.current += 1);
  }, [isOpen, load]);

  const retry = useCallback(() => {
    setFocusKey((key) => key + 1);
    load();
  }, [load]);

  // The write locks the dialog at once; its spinner waits out the gate so a
  // quick answer never flashes one.
  const showBusySpinner = useDohertyGate(busy);
  const stillWorking = useDeferredLoading(busy, UI_STILL_WORKING_MS);
  const holdSkeleton = useSkeletonFloor(useDohertyGate(preview.kind === "loading"));

  // The notice for a mode that changed under the user mounts with its words
  // already in it, so it can't announce itself. The dialog's own announcer
  // exists before the read lands and says it once.
  const readPr = request && preview.kind === "loaded" ? preview.pr : null;
  const readMode = request && readPr ? effectiveMergeMode(readPr, request.mode) : null;
  const modeChangeMessage =
    request && readPr && readMode && readMode !== request.mode
      ? readMode === "merge"
        ? `Pull request #${prNumber} can merge now. Confirming merges it into ${readPr.baseRef} now.`
        : readPr.mergeQueueRequired === true
          ? `Pull request #${prNumber} can't merge yet. Confirming adds it to the merge queue instead.`
          : `Pull request #${prNumber} can't merge yet. Confirming enables auto-merge instead.`
      : null;
  // A read that couldn't say whether it can merge blocks the write without
  // changing anything else on screen, so it has to be said too.
  const unreportedMessage =
    request &&
    readPr &&
    readMode !== "cancel" &&
    readPr.state === "open" &&
    !readPr.merged &&
    !readPr.isDraft &&
    !readPr.mergeStatus
      ? `GitHub didn't report whether pull request #${prNumber} can merge. Retry to read it again.`
      : null;
  const readAnnouncement = modeChangeMessage ?? unreportedMessage;
  useEffect(() => {
    if (readAnnouncement) useAnnouncerStore.getState().announce(readAnnouncement, "polite");
  }, [readAnnouncement]);

  if (!request) return null;

  const loadedPr = preview.kind === "loaded" ? preview.pr : null;
  const showSkeleton = preview.kind === "loading" || holdSkeleton;
  const pr = showSkeleton ? null : loadedPr;
  // Decided by the latest read alone. An arm GitHub declined as already
  // mergeable reloads, and the read then says so — no override that could
  // outlive the state it described.
  const mode: PrMergeMode = loadedPr ? effectiveMergeMode(loadedPr, request.mode) : request.mode;
  const changedMode = loadedPr !== null && mode !== request.mode;
  const queue = loadedPr ? loadedPr.mergeQueueRequired === true : request.queue;
  const method = queue ? null : request.method;
  const headSha = loadedPr?.headSha ?? null;
  const repository = loadedPr ? repositoryFromUrl(loadedPr.url) : null;
  const commits = loadedPr?.commits;
  const baseRef = loadedPr?.baseRef ?? request.baseRef;
  const prTitle = loadedPr?.title ?? request.title;
  const intent = loadedPr ? (loadedPr.mergeIntent ?? null) : request.intent;
  const queuedIntent = intent?.kind === "queued";
  const nothingPending = mode === "cancel" && loadedPr !== null && !loadedPr.mergeIntent;
  const blockReason = loadedPr ? confirmBlockReason(loadedPr, mode, { repository, method }) : null;
  const confirmDisabled = busy || !pr || blockReason !== null;

  const handleConfirm = async () => {
    if (confirmDisabled || !loadedPr) return;
    const generation = generationRef.current;
    setBusy(true);
    setRejection(null);
    const target = { worktreePath, prNumber };
    const pin = {
      ...(method ? { mergeMethod: method } : {}),
      expectedHeadSha: headSha!,
      expectedBaseRef: loadedPr.baseRef,
    };
    const result =
      mode === "arm"
        ? await actionService.dispatch(
            "forge.enableAutoMerge",
            { ...target, ...pin },
            { source: "user" }
          )
        : mode === "merge"
          ? await actionService.dispatch("forge.mergePR", { ...target, ...pin }, { source: "user" })
          : await actionService.dispatch("forge.disableAutoMerge", target, { source: "user" });
    if (generationRef.current !== generation) return;
    setBusy(false);
    if (!result.ok) {
      // Whatever GitHub said, the preview is now older than the attempt. Read
      // it again so the next press is decided against where the PR stands,
      // and lock the primary until that read lands.
      setRejection(result.error.message || "");
      setAttempt((value) => value + 1);
      setFocusKey((key) => key + 1);
      load();
      return;
    }
    const outcome = readOutcome(mode, result.result, { baseRef: loadedPr.baseRef, queue, method });
    if (outcome === "already-mergeable") {
      // Ask again, against a fresh read of what would land now.
      setFocusKey((key) => key + 1);
      load();
      return;
    }
    onComplete?.(outcome);
    // The forge decides what happened; a forced detection pass is what shows it.
    void worktreeClient.refreshPullRequests().catch(() => {});
    onClose();
  };

  const title =
    mode === "cancel"
      ? nothingPending
        ? `Nothing pending for #${prNumber}`
        : queuedIntent
          ? `Remove #${prNumber} from the merge queue?`
          : `Cancel auto-merge for #${prNumber}?`
      : mode === "merge"
        ? `Merge #${prNumber} into ${baseRef}?`
        : queue
          ? `Merge #${prNumber} when ready?`
          : `Enable auto-merge for #${prNumber}?`;

  const count = commits?.totalCount;
  const consequence: ReactNode =
    mode === "merge"
      ? count === undefined || !method
        ? `Writes this pull request into ${baseRef} for everyone working from it.`
        : method === "squash"
          ? `Squashes ${pluralize(count, "commit")} into one commit on ${baseRef}, for everyone working from it.`
          : method === "rebase"
            ? `Replays ${pluralize(count, "commit")} onto ${baseRef}, for everyone working from it.`
            : `Adds ${pluralize(count, "commit")} and a merge commit to ${baseRef}, for everyone working from it.`
      : mode === "arm"
        ? queue
          ? `GitHub adds it to the ${baseRef} merge queue once requirements pass, and the queue merges it.`
          : `GitHub merges it into ${baseRef} once required checks and reviews pass.`
        : nothingPending
          ? "GitHub no longer reports auto-merge or a queue entry for it. It may have merged, or been cancelled somewhere else."
          : queuedIntent
            ? `GitHub takes it out of the ${baseRef} merge queue. You can add it back later.`
            : "GitHub stops merging it automatically. The pull request stays open.";

  // A merge, now or later, writes into the shared base; cancelling only stops one.
  const variantProps =
    mode === "cancel" ? ({ variant: "default" } as const) : ({ variant: "destructive" } as const);

  const pushCaveat = (
    <span data-testid="pr-merge-push-warning">
      {queue ? "Merge when ready" : "Auto-merge"} stays on when anyone with write access pushes,
      including your own agents, which push as you.
    </span>
  );

  const rejected =
    rejection !== null ? describeMergeRejection(rejection, mode, { baseRef, queue }) : null;

  const hint =
    preview.kind === "loading" ? (
      "Reading the PR…"
    ) : busy && stillWorking ? (
      "Still working…"
    ) : nothingPending ? undefined : blockReason === MERGE_STATUS_UNREPORTED_REASON ? (
      // Said in the frame already, beside its own Retry. Kept for
      // assistive tech, so the disabled primary still names its reason.
      <span className="sr-only">
        GitHub didn&apos;t report whether it can merge. Retry to read it again.
      </span>
    ) : (
      blockReason
    );

  const cancelLabel =
    mode !== "cancel"
      ? "Cancel"
      : nothingPending
        ? "Close"
        : queuedIntent
          ? "Keep in queue"
          : "Keep auto-merge";

  return (
    <ConfirmDialog
      {...variantProps}
      isOpen={true}
      title={title}
      // The PR's own name, marked as one so an imperative title doesn't read
      // as an instruction from the dialog.
      description={
        <span className="flex items-start gap-2">
          <GitPullRequest
            className="w-3.5 h-3.5 mt-[3px] shrink-0 text-text-secondary"
            aria-hidden="true"
          />
          <span
            className="min-w-0 font-medium text-text-primary break-words"
            data-testid="pr-merge-title"
          >
            {prTitle}
          </span>
        </span>
      }
      onClose={onClose}
      onConfirm={handleConfirm}
      confirmLabel={mergeActionLabel(mode, { queue, intent })}
      cancelLabel={cancelLabel}
      hasPreview={true}
      isBusy={busy}
      isConfirmLoading={showBusySpinner}
      confirmDisabled={confirmDisabled}
      // A mode that changes under the user — arm turned into a merge — earns a
      // fresh read-time gate, so a double-click aimed at the first can't land
      // on the second. So does the attempt after a rejection.
      confirmCooldownMs={MODE_COOLDOWN_MS}
      cooldownKey={`${mode}:${attempt}`}
      focusResetKey={focusKey}
      restoreFocusTo={restoreFocusTo}
      hint={hint}
    >
      <div className="space-y-3 text-xs text-text-primary">
        {/* Nothing to describe the consequence of until there is a PR to act on. */}
        {preview.kind !== "error" && preview.kind !== "missing" && (
          <p data-testid="pr-merge-consequence">{consequence}</p>
        )}

        <PreviewFrame>
          {rejected && (
            <PreviewNotice tone="error" title={rejected.title} testId="pr-merge-error">
              {rejected.summary}
              <TechnicalDetails text={rejection ?? ""} />
            </PreviewNotice>
          )}
          {preview.kind === "error" && !showSkeleton && (
            <PreviewNotice
              tone="error"
              title="Couldn't read the pull request"
              onRetry={retry}
              retryTestId="pr-merge-retry"
            >
              GitHub didn&apos;t answer, so there&apos;s nothing to preview yet.
              <TechnicalDetails text={preview.message} />
            </PreviewNotice>
          )}
          {preview.kind === "missing" && !showSkeleton && (
            <PreviewNotice
              tone="error"
              title={`Pull request #${prNumber} wasn't found`}
              onRetry={retry}
              retryTestId="pr-merge-retry"
            >
              It may have been deleted, or moved to another repository.
            </PreviewNotice>
          )}
          {pr && mode !== "cancel" && !pr.mergeStatus && (
            <PreviewNotice
              tone="warning"
              title="Merge status not reported"
              onRetry={retry}
              retryTestId="pr-merge-retry"
              testId="pr-merge-status-unreported"
            >
              GitHub didn&apos;t say whether it can merge. Retry to read it again.
            </PreviewNotice>
          )}
          {pr && changedMode && (
            <PreviewNotice
              tone="warning"
              title={
                mode === "merge"
                  ? "It can merge now"
                  : queue
                    ? "It can't merge yet, so this queues it"
                    : "It can't merge yet, so this enables auto-merge"
              }
              testId="pr-merge-mode-changed"
            >
              {mode === "merge" ? (
                "GitHub won't enable auto-merge for a pull request that's ready. Confirming merges it now."
              ) : (
                <>It changed since the checks were read. {pushCaveat}</>
              )}
            </PreviewNotice>
          )}
          {/* Static, so it's there from the first frame and the dialog doesn't
              grow under the reader when the read lands. Not over a failed read,
              where there's nothing to arm. */}
          {(pr || showSkeleton) &&
            mode === "arm" &&
            !changedMode &&
            blockReason !== MERGE_STATUS_UNREPORTED_REASON && (
              <PreviewNotice tone="warning" title="Later pushes can merge without another review">
                {pushCaveat}
              </PreviewNotice>
            )}

          {showSkeleton && (
            <>
              <PreviewSummary testId="pr-merge-preview-loading" busy>
                <SummaryRow label="Repo">
                  <Bone className="w-36" />
                </SummaryRow>
                <SummaryRow label="Into">
                  <Bone className="w-20" />
                </SummaryRow>
                <SummaryRow label="From">
                  <Bone className="w-44" />
                </SummaryRow>
                <SummaryRow label="Head">
                  <Bone className="w-14" />
                </SummaryRow>
                {mode !== "cancel" && (
                  <SummaryRow label="Method">
                    <Bone className="w-16" />
                  </SummaryRow>
                )}
              </PreviewSummary>
              {mode !== "cancel" && (
                <>
                  <PreviewSectionHeading label="Commits" />
                  <PreviewSkeleton label="Reading the pull request" />
                </>
              )}
            </>
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
                  <span data-testid="pr-merge-method">
                    {queue ? "Set by the merge queue" : method ? METHOD_LABEL[method] : "—"}
                  </span>
                </SummaryRow>
              )}
            </PreviewSummary>
          )}

          {pr && mode !== "cancel" && commits && (
            <>
              <PreviewSectionHeading label="Commits" count={commits.totalCount} />
              {commits.items.length > 0 ? (
                <>
                  {commits.totalCount > commits.items.length && (
                    // Said before the list, not only at its end: the cap line
                    // inside sits after every fetched row.
                    <p
                      className="px-3 -mt-1 pb-2 text-2xs text-text-secondary"
                      data-testid="pr-merge-commit-cap-note"
                    >
                      Showing the {commits.items.length} most recent of{" "}
                      {pluralize(commits.totalCount, "commit")}
                    </p>
                  )}
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
                </>
              ) : (
                <PreviewNote>GitHub listed no commits for this pull request.</PreviewNote>
              )}
            </>
          )}
        </PreviewFrame>
      </div>
    </ConfirmDialog>
  );
}

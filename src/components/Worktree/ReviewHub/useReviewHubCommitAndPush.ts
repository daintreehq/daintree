import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PushProgressEvent } from "@shared/types/ipc/gitPush";
import type { GitPushReview } from "@shared/types/git";
import { isClientAppError } from "@/utils/clientAppError";
import type { debounce } from "@/utils/debounce";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { useDiffViewedStore } from "@/store/diffViewedStore";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { forgeClient } from "@/clients/forgeClient";
import { mintRemoteOperationId } from "@/clients/operationsClient";
import { runHostOperation } from "@/hooks/useHostConnection";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { classifyGitError } from "@shared/utils/gitOperationErrors";
import { type PushErrorState, readGitErrorFields } from "./reviewHubUtils";
import type { ReviewHubActionFailure } from "./useReviewHubStagingActions";

interface UseReviewHubCommitAndPushArgs {
  worktreePath: string;
  refresh: () => Promise<void>;
  setActionError: (failure: ReviewHubActionFailure | null) => void;
  debouncedBgRefreshRef: RefObject<ReturnType<typeof debounce> | null>;
  /**
   * Called the moment a commit lands, before the refresh and any push: a
   * message must not sit in the composer as unsent while its push runs.
   */
  onCommitted: (worktreePath: string, message: string) => void;
}

/**
 * The hub's remote-facing git writes — commit, commit-and-push, push, pull
 * with rebase and the force-push recovery — with the push progress, the push
 * error banner and its provider classification. Every write keeps the D2
 * confirm and the remote operation id it had inline.
 */
export function useReviewHubCommitAndPush({
  worktreePath,
  refresh,
  setActionError,
  debouncedBgRefreshRef,
  onCommitted,
}: UseReviewHubCommitAndPushArgs) {
  const [pushError, setPushError] = useState<PushErrorState | null>(null);
  // Provider-classified push-error state, resolved async via the active forge
  // provider (ForgeProviderImpl lives in main). `forgeErrorCode` is a stable,
  // searchable code (e.g. `GH###`); `forgeProviderId` is the resolved
  // provider's contribution id, used to route the settings CTA. Both null when
  // no provider resolves or it doesn't recognize the stderr.
  const [forgeErrorCode, setForgeErrorCode] = useState<string | undefined>(undefined);
  const [forgeProviderId, setForgeProviderId] = useState<string | null>(null);
  const [showPushDetails, setShowPushDetails] = useState(false);
  // Dismissing the banner hides the presentation only. The failure itself stays
  // in `pushError`, so readiness gating is unchanged and the rail takes the
  // `push-failed` blocker back; the next failed attempt shows the banner again.
  const [pushBannerDismissed, setPushBannerDismissed] = useState(false);
  const showPushBanner = pushError !== null && !pushBannerDismissed;
  const [pushProgress, setPushProgress] = useState<Map<string, PushProgressEvent>>(new Map());
  const [pushTargetBranch, setPushTargetBranch] = useState<string | null>(null);
  // A commit that empties the tree would otherwise unmount the composer before
  // its push starts, taking the push target and progress with it.
  const [isCommitPushInFlight, setIsCommitPushInFlight] = useState(false);
  // Spoken once when a push lands. The composer that showed its progress may
  // already be gone (a clean tree unmounts it), so the result lives here.
  const [pushAnnouncement, setPushAnnouncement] = useState("");
  const [isPushing, setIsPushing] = useState(false);
  const [pullRebasing, setPullRebasing] = useState(false);
  const isPullRebasingRef = useRef(false);

  useEffect(() => {
    setShowPushDetails(false);
    setPushBannerDismissed(false);
  }, [pushError]);

  // Classify push failures via the active forge provider (lives in main).
  // Provider-agnostic: surfaces a stable error code and the provider id used
  // to route the settings CTA. Classification is best-effort — any failure
  // leaves the banner in its generic state with the raw stderr.
  useEffect(() => {
    // Clear synchronously so a new failure never shows the previous error's
    // code or routes its settings CTA to a stale provider while the new
    // classification is in flight.
    setForgeErrorCode(undefined);
    setForgeProviderId(null);
    if (!pushError || !worktreePath) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await forgeClient.classifyPushError(worktreePath, pushError.rawMessage);
        if (cancelled) return;
        setForgeProviderId(result?.providerId ?? null);
        setForgeErrorCode(result?.classification?.code);
      } catch {
        if (cancelled) return;
        setForgeProviderId(null);
        setForgeErrorCode(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushError, worktreePath]);

  const handleCommit = useCallback(
    async (message: string) => {
      setActionError(null);
      debouncedBgRefreshRef.current?.cancel();
      try {
        await window.electron.git.commit(worktreePath, message);
        onCommitted(worktreePath, message);
        // A commit resets the review: anything still (or newly) changed after
        // it is a new change, so stale viewed markers must not stick to it.
        useDiffViewedStore.getState().clearWorktree(worktreePath);
        await refresh();
      } catch (err) {
        // No Retry: the message is still in the composer and the Commit button
        // is the retry — it owns the busy state, the in-flight guard and the
        // draft clearing that a re-run from here would skip.
        setActionError({
          title: "Couldn't commit changes",
          detail: formatErrorMessage(err, "Failed to commit changes"),
        });
        throw err;
      }
    },
    [worktreePath, refresh, setActionError, debouncedBgRefreshRef, onCommitted]
  );

  const isPushingRef = useRef(false);
  /**
   * The review the last push ran under, so Retry pushes what was approved
   * rather than whatever the branch holds by then (#15646). `null` for the
   * commit-and-push path, whose confirm pins nothing.
   */
  const lastPushReviewRef = useRef<GitPushReview | null>(null);

  const runPush = useCallback(async (review: GitPushReview | null) => {
    if (isPushingRef.current) return;
    isPushingRef.current = true;
    lastPushReviewRef.current = review;
    setIsPushing(true);
    setPushError(null);
    setPushProgress(new Map());
    setPushTargetBranch(null);
    setPushAnnouncement("");
    let announcedTarget: string | null = null;

    const cleanup = window.electron.git.onPushProgress((event) => {
      if (event.cwd !== worktreePath) return;
      if (event.stage === "target") {
        announcedTarget = event.targetBranch ?? null;
        setPushTargetBranch(event.targetBranch ?? null);
        return;
      }
      setPushProgress((prev) => {
        const next = new Map(prev);
        next.set(event.stage, event);
        return next;
      });
    });

    // Drop any lease captured by an earlier rejection before pushing again —
    // the same order `git.push`'s action uses. Without it a push that fails for
    // some OTHER reason (or succeeds) leaves the previous rejection's lease
    // standing, and the worktree card goes on offering a recovery for a remote
    // state nobody has observed since.
    useGitForcePushStore.getState().clearRecovery(worktreePath);
    try {
      const opId = mintRemoteOperationId();
      await runHostOperation(
        opId,
        () =>
          review
            ? window.electron.git.push(worktreePath, undefined, opId, review)
            : opId
              ? window.electron.git.push(worktreePath, undefined, opId)
              : window.electron.git.push(worktreePath),
        { fromResult: () => undefined }
      );
      setPushError(null);
      setPushAnnouncement(announcedTarget ? `Pushed to ${announcedTarget}` : "Push complete");
    } catch (err) {
      // GitOperationError carries `gitReason` (auth-failed, push-rejected-*, etc.).
      // AppError carries `code` from a different union (RATE_LIMITED, etc.) — fall
      // back to "unknown" so getPushBannerConfig surfaces the raw message rather
      // than rendering an unmapped reason.
      const errFields = readGitErrorFields(err);
      const isRateLimited =
        isClientAppError(err) && (err as { code?: string }).code === "RATE_LIMITED";
      const rawMessage = isRateLimited
        ? "Too many push attempts in a short window — wait a moment and try again."
        : formatErrorMessage(err, "Failed to push");
      setPushError({
        reason: errFields.gitReason ?? classifyGitError(rawMessage),
        rawMessage,
        leaseSha: errFields.leaseSha,
        branchName: errFields.branchName,
      });
      // This pane pushes through the IPC directly rather than the `git.push`
      // action, so the action's own capture never runs here. Publishing the
      // lease to the shared store is what lets the worktree card offer the
      // same recovery the banner below does — and keeps ONE lease per
      // worktree, captured at one rejection, however the push was started.
      useGitForcePushStore.getState().recordRejection({
        cwd: worktreePath,
        branchName: errFields.branchName,
        leaseSha: errFields.leaseSha,
      });
    } finally {
      cleanup();
      setIsPushing(false);
      isPushingRef.current = false;
    }
  }, [worktreePath]);

  const handleCommitAndPush = useCallback(
    async (message: string) => {
      setActionError(null);
      setPushError(null);
      debouncedBgRefreshRef.current?.cancel();
      setIsCommitPushInFlight(true);
      try {
        try {
          await window.electron.git.commit(worktreePath, message);
        } catch (err) {
          setActionError({
            title: "Couldn't commit changes",
            detail: formatErrorMessage(err, "Failed to commit changes"),
          });
          throw err;
        }
        onCommitted(worktreePath, message);
        // Same review reset as handleCommit — the changeset starts over.
        useDiffViewedStore.getState().clearWorktree(worktreePath);
        await refresh();
        await runPush(null);
      } finally {
        setIsCommitPushInFlight(false);
      }
    },
    [worktreePath, refresh, runPush, setActionError, debouncedBgRefreshRef, onCommitted]
  );

  const handleRetryPush = useCallback(async () => {
    setPushError(null);
    debouncedBgRefreshRef.current?.cancel();
    await runPush(lastPushReviewRef.current);
  }, [runPush, debouncedBgRefreshRef]);

  // Push from the clean-tree state, where no CommitPanel (and thus no local
  // push confirm) is mounted. Routes through the same D2 preview dialog the
  // git.push action uses, then reuses runPush so progress and error banners
  // stay on the hub's existing paths.
  const handlePushClean = useCallback(async () => {
    const result = await useGitPushConfirmStore.getState().requestConfirmation(worktreePath);
    if (!result.confirmed) return;
    await runPush(result.review);
  }, [worktreePath, runPush]);

  const handlePullRebase = useCallback(async () => {
    if (isPullRebasingRef.current) return;
    isPullRebasingRef.current = true;
    setPullRebasing(true);
    debouncedBgRefreshRef.current?.cancel();
    try {
      await window.electron.git.pullRebase(worktreePath);
      // Successful rebase may have changed the working tree; refresh staging
      // status before clearing the banner so the user sees the new state.
      await refresh();
      setPushError(null);
    } catch (err) {
      // A rebase that halts on conflicts surfaces as `conflict-unresolved`;
      // surface it through the same banner so the user sees the next step.
      const errFields = readGitErrorFields(err);
      const rawMessage = formatErrorMessage(err, "Failed to pull and rebase");
      setPushError({
        reason: errFields.gitReason ?? classifyGitError(rawMessage),
        rawMessage,
      });
      // Refresh in case the rebase started and left files in conflict.
      await refresh();
    } finally {
      isPullRebasingRef.current = false;
      setPullRebasing(false);
    }
  }, [worktreePath, refresh, debouncedBgRefreshRef]);

  // Confirmed through the same dialog the `git.pullRebase` action uses, so the
  // Review Hub CTA shows the upstream, the incoming commits and the replay set
  // rather than two counts. It used to open its own count-only confirm, which
  // made the same operation look different depending on where it was started.
  const confirmPullRebase = useCallback(async () => {
    const confirmed = await useGitPullRebaseConfirmStore
      .getState()
      .requestConfirmation(worktreePath);
    if (!confirmed) return;
    await handlePullRebase();
  }, [worktreePath, handlePullRebase]);

  /**
   * The banner CTA dispatches the action rather than opening a dialog of its
   * own. `git.forcePushWithLease` owns the confirm (globally mounted), the
   * lease it was captured with, and the IPC — so this pane and the worktree
   * card force push through exactly one path.
   */
  const handleForcePush = useCallback(async () => {
    const result = await actionService.dispatch(
      "git.forcePushWithLease",
      { cwd: worktreePath },
      { source: "user" }
    );
    if (result.ok) {
      // A declined confirm succeeds with `forced: false`. Clearing the banner
      // there would retract the recovery CTA the user just backed out of.
      const forced =
        typeof result.result === "object" &&
        result.result !== null &&
        "forced" in result.result &&
        result.result.forced === true;
      if (forced) {
        setPushError(null);
        void refresh();
      }
      return;
    }
    // Re-banner it: the old error described the rejected push, and this one
    // describes why the recovery from it did not take.
    const rawMessage = result.error.message || "Failed to force push";
    setPushError({
      reason: classifyGitError(rawMessage),
      rawMessage,
    });
  }, [worktreePath, refresh]);

  const clearPushError = useCallback(() => setPushError(null), []);

  const reset = useCallback(() => {
    setPushError(null);
    setPullRebasing(false);
    isPullRebasingRef.current = false;
  }, []);

  return {
    pushError,
    showPushBanner,
    forgeErrorCode,
    forgeProviderId,
    showPushDetails,
    setShowPushDetails,
    setPushBannerDismissed,
    pushProgress,
    pushTargetBranch,
    isCommitPushInFlight,
    pushAnnouncement,
    isPushing,
    pullRebasing,
    handleCommit,
    handleCommitAndPush,
    handleRetryPush,
    handlePushClean,
    confirmPullRebase,
    handleForcePush,
    clearPushError,
    reset,
  };
}

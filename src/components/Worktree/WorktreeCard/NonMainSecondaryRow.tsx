import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { BranchLabel } from "../BranchLabel";
import { UpstreamSyncBadge } from "./UpstreamSyncBadge";
import { IssueBadge } from "./IssueBadge";
import { PRBadge } from "./PRBadge";
import { FileText } from "lucide-react";
import type { WorktreeState } from "@/types";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { useResourceProfileStore } from "@/store/resourceProfileStore";
import { computeAlarmTier } from "@/lib/worktreeAlarmTier";

interface NonMainSecondaryRowProps {
  worktree: WorktreeState;
  branchLabel: string;
  isActive: boolean;
  isMuted?: boolean;
  underlineOnHover: boolean;
  hasUpstreamDelta: boolean;
  hasAuthFailedSignIn: boolean;
  /**
   * True when the headline above renders a title — canonical `issueTitle` or
   * the offline `branchDerivedTitle` fallback. Drives the branch secondary
   * line, which surfaces below either form of title (#8851).
   */
  hasDisplayTitle: boolean;
  /**
   * True when the worktree was created from the PR dropdown (#8888): the PR is
   * the headline, so suppress the subordinate PR badge here and instead surface
   * the linked issue underneath.
   */
  isPrOriginated: boolean;
  hasPlanFile: boolean;
  badges: {
    onOpenIssue?: () => void;
    onOpenPR?: () => void;
    onOpenPlan?: () => void;
  };
}

export function NonMainSecondaryRow({
  worktree,
  branchLabel,
  isActive,
  isMuted,
  underlineOnHover,
  hasUpstreamDelta,
  hasAuthFailedSignIn,
  hasDisplayTitle,
  isPrOriginated,
  hasPlanFile,
  badges,
}: NonMainSecondaryRowProps) {
  const prDetectionPaused = usePRCircuitBreakerStore((s) => s.tripped);
  const fetchIntervalActiveMs = useResourceProfileStore((s) => s.fetchIntervalActiveMs);
  const fetchIntervalBackgroundMs = useResourceProfileStore((s) => s.fetchIntervalBackgroundMs);

  const fetchIntervalMs = useMemo(
    () => (worktree.isCurrent ? fetchIntervalActiveMs : fetchIntervalBackgroundMs),
    [worktree.isCurrent, fetchIntervalActiveMs, fetchIntervalBackgroundMs]
  );

  // Suppress the subordinate PR badge when the PR is already the headline
  // (PR-originated worktrees, #8888) — the linked issue takes the secondary row.
  const showPRBadge =
    !isPrOriginated &&
    worktree.linked?.pr &&
    worktree.linked.pr.state !== "closed" &&
    worktree.linked.pr.state !== "declined";
  const showUpstreamBadge = hasUpstreamDelta || hasAuthFailedSignIn;

  const prTier = showPRBadge
    ? computeAlarmTier({ ciState: worktree.linked?.pr?.ciStatus?.state }).tier
    : 0;
  const upstreamTier = computeAlarmTier({
    authFailed: hasAuthFailedSignIn,
    behindCount: worktree.behindCount,
  }).tier;
  const upstreamFirst = upstreamTier > prTier;

  const prBadge = showPRBadge ? (
    <PRBadge
      prNumber={worktree.linked!.pr!.ref.number}
      prState={worktree.linked!.pr!.state}
      prCiStatus={worktree.linked!.pr!.ciStatus}
      isSubordinate={!!worktree.issueNumber}
      worktreePath={worktree.path}
      onOpen={badges.onOpenPR}
      isActive={isActive}
      underlineOnHover={underlineOnHover}
      prDetectionPaused={prDetectionPaused}
    />
  ) : null;

  const upstreamBadge = showUpstreamBadge ? (
    <UpstreamSyncBadge
      aheadCount={worktree.aheadCount}
      behindCount={worktree.behindCount}
      isFetchInFlight={Boolean(worktree.isFetchInFlight)}
      lastFetchedAt={worktree.lastFetchedAt}
      fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
      fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
      hasAuthFailedSignIn={hasAuthFailedSignIn}
      authProviderId={worktree.matchedForgeProviderId ?? worktree.linked?.providerId ?? null}
      containerGapClass="gap-1.5"
      baseBranchName={worktree.baseBranchName}
      baseAheadCount={worktree.baseAheadCount}
      baseBehindCount={worktree.baseBehindCount}
      baseMatchesUpstream={worktree.baseMatchesUpstream}
      baseCompareRef={worktree.baseCompareRef}
      fetchIntervalMs={fetchIntervalMs}
    />
  ) : null;

  return (
    // gap-0.5 inside, mt-2.5 outside. These lines are one thing — branch,
    // linked PR, upstream drift — and they read fine at 2px apart; what made
    // the card feel oppressive was that the block sat only 6px under the
    // headline, inside the 5-7px zone where the eye cannot tell whether a line
    // belongs to the block above it or starts a new one. 10px puts it clearly
    // outside, and holds the 2:1-to-3:1 outer-to-inner ratio the grouping
    // convention asks for.
    <div className="flex flex-col gap-0.5 mt-2.5">
      {worktree.issueNumber && (isPrOriginated || !hasDisplayTitle) && (
        <IssueBadge
          issueNumber={worktree.issueNumber}
          issueTitle={isPrOriginated ? worktree.issueTitle : undefined}
          worktreePath={worktree.path}
          onOpen={badges.onOpenIssue}
          isActive={isActive}
          underlineOnHover={underlineOnHover}
        />
      )}
      {/* Branch before upstream delta: the branch is identity, the delta is
          state, and the card answers "which worktree is this?" before "how far
          has it drifted?". The upstream/PR pair still swaps between itself by
          alarm tier — that ordering is about which alarm outranks which, not
          about outranking the branch name. */}
      {hasDisplayTitle && (
        <BranchLabel
          label={branchLabel}
          isActive={isActive}
          isMuted={isMuted}
          isMainWorktree={false}
        />
      )}
      {upstreamFirst ? upstreamBadge : prBadge}
      {upstreamFirst ? prBadge : upstreamBadge}
      {hasPlanFile && badges.onOpenPlan && (
        <button
          type="button"
          onClick={() => {
            if (isActive) badges.onOpenPlan?.();
          }}
          data-no-dnd
          className="flex items-center gap-1 text-xs text-left cursor-pointer transition-colors text-daintree-text/70 hover:text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
          aria-disabled={!isActive || undefined}
          aria-label="View agent plan file"
        >
          <FileText className="w-3 h-3 shrink-0 text-daintree-text/50" aria-hidden="true" />
          <span className={cn("font-mono", underlineOnHover && "hover:underline")}>
            {worktree.planFilePath ?? "Plan"}
          </span>
        </button>
      )}
    </div>
  );
}

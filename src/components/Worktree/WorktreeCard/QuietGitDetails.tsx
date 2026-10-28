import type { WorktreeState } from "@/types";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { BranchLabel } from "../BranchLabel";
import { IssueBadge } from "./IssueBadge";
import { PRBadge } from "./PRBadge";
import { UpstreamSyncBadge } from "./UpstreamSyncBadge";

interface QuietGitDetailsProps {
  worktree: WorktreeState;
  branchLabel: string;
  isActive: boolean;
  onOpenIssue?: () => void;
  onOpenPR?: () => void;
}

/**
 * Where quiet git detail (#13777) goes: the branch, issue, PR and sync line the
 * card's header stops drawing, at the top of the expanded details. A disclosure
 * rather than a tooltip, because the issue and PR badges open things and a
 * tooltip's content is out of reach of the keyboard.
 */
export function QuietGitDetails({
  worktree,
  branchLabel,
  isActive,
  onOpenIssue,
  onOpenPR,
}: QuietGitDetailsProps) {
  const prDetectionPaused = usePRCircuitBreakerStore((s) => s.tripped);
  const pr =
    worktree.linked?.pr &&
    worktree.linked.pr.state !== "closed" &&
    worktree.linked.pr.state !== "declined"
      ? worktree.linked.pr
      : undefined;
  const isDetached = Boolean(worktree.isDetached);
  const hasAuthFailedSignIn = Boolean(
    worktree.fetchAuthFailed &&
    (worktree.matchedForgeProviderId != null || worktree.linked?.providerId != null)
  );
  const hasNoUpstream =
    !isDetached && worktree.worktreeChanges != null && !worktree.worktreeChanges.tracking;

  return (
    <div className="mb-2 flex flex-col gap-0.5" data-testid="worktree-quiet-git-details">
      <BranchLabel label={branchLabel} isActive={isActive} />
      {worktree.issueNumber && (
        <IssueBadge
          issueNumber={worktree.issueNumber}
          issueTitle={worktree.issueTitle ?? worktree.branchDerivedTitle}
          provenance={worktree}
          worktreePath={worktree.path}
          onOpen={onOpenIssue}
          isActive={isActive}
          underlineOnHover
        />
      )}
      {pr && (
        <PRBadge
          prNumber={pr.ref.number}
          prTitle={pr.title ?? worktree.prTitle}
          prState={pr.state}
          prCiStatus={pr.ciStatus}
          mergeIntent={pr.mergeIntent}
          headMovedWhileArmed={pr.headMovedWhileArmed}
          isSubordinate={false}
          worktreePath={worktree.path}
          onOpen={onOpenPR}
          isActive={isActive}
          underlineOnHover
          prDetectionPaused={prDetectionPaused}
        />
      )}
      <UpstreamSyncBadge
        aheadCount={worktree.aheadCount}
        behindCount={worktree.behindCount}
        isFetchInFlight={Boolean(worktree.isFetchInFlight)}
        lastFetchedAt={worktree.lastFetchedAt}
        fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
        fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
        hasAuthFailedSignIn={hasAuthFailedSignIn}
        containerGapClass="gap-1.5"
        baseBranchName={isDetached ? undefined : worktree.baseBranchName}
        baseAheadCount={worktree.baseAheadCount}
        baseBehindCount={worktree.baseBehindCount}
        baseMatchesUpstream={worktree.baseMatchesUpstream}
        baseCompareRef={worktree.baseCompareRef}
        hasNoUpstream={hasNoUpstream}
      />
    </div>
  );
}

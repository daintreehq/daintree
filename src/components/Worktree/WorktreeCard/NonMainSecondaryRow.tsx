import { cn } from "@/lib/utils";
import { BranchLabel } from "../BranchLabel";
import { UpstreamSyncBadge } from "./UpstreamSyncBadge";
import { IssueBadge } from "./IssueBadge";
import { PRBadge } from "./PRBadge";
import { FileText } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { WorktreeState } from "@/types";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { computeAlarmTier, isPullRequestWarning } from "@/lib/worktreeAlarmTier";

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
   * A custom title holds the headline (#13409), so whatever it displaced — the
   * issue or PR with its title, or the branch — leads this stack instead.
   */
  hasCustomTitle?: boolean;
  /**
   * True when the worktree was created from the PR dropdown (#8888): the PR is
   * the headline, so suppress the subordinate PR badge here and instead surface
   * the linked issue underneath.
   */
  isPrOriginated: boolean;
  hasPlanFile: boolean;
  /**
   * The project's presentation profile quiets git detail (#13777): branch,
   * issue and PR identity move to the card's expanded details, and only what
   * is a warning stays here — failing CI, a head that moved under an armed
   * merge, drift behind upstream or base, and a failed fetch.
   */
  quietGit?: boolean;
  variant?: "sidebar" | "grid";
  /**
   * A compact sidebar card lays the stack out tighter: the PR shares the
   * branch's row, and the sync line stays on the card only when it reports a
   * failure (the rest of it is in Details). A comfortable card keeps one line
   * per fact, as the grid does.
   */
  density?: "comfortable" | "compact";
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
  hasCustomTitle = false,
  isPrOriginated,
  hasPlanFile,
  quietGit = false,
  variant = "sidebar",
  density = "compact",
  badges,
}: NonMainSecondaryRowProps) {
  // The issue badge carries its title wherever it stands in for a headline:
  // under a PR headline, and under a custom title that displaced the issue.
  const issueBadgeTitle = isPrOriginated
    ? worktree.issueTitle
    : hasCustomTitle
      ? (worktree.issueTitle ?? worktree.branchDerivedTitle)
      : undefined;
  const sourcePrNumber = worktree.sourcePrNumber;
  const planFileName = worktree.planFilePath ?? "Plan";
  const prDetectionPaused = usePRCircuitBreakerStore((s) => s.tripped);
  // Suppress the subordinate PR badge when the PR is already the headline
  // (PR-originated worktrees, #8888) — the linked issue takes the secondary row.
  const showPRBadge =
    !isPrOriginated &&
    worktree.linked?.pr &&
    worktree.linked.pr.state !== "closed" &&
    worktree.linked.pr.state !== "declined";
  // The base relationship is not an alarm, so it does not wait for a non-zero
  // count: a branch renders the line as soon as we know what it is measured
  // against. `hasUpstreamDelta` still matters for the ordering below, where
  // the question genuinely is which alarm outranks which.
  //
  // Detached HEAD is excluded because the relationship is a claim about a
  // branch and there is no branch: on detach `readCurrentBranch` returns
  // undefined and the producer's branch-change guard declines to clear the
  // previous name, so `baseBranchName` survives the detach and would describe
  // a bare commit as a branch sitting on its base. A detached worktree that
  // has genuinely drifted still shows the counts — that path mounts on
  // `hasUpstreamDelta` and is unchanged.
  const isDetached = Boolean(worktree.isDetached);
  const isSidebar = variant === "sidebar";
  const isCompact = isSidebar && density === "compact";
  // Any status pass or fetch mounts it too: with no counts and no base to
  // show, the badge's own marks (failed, no upstream) are the only
  // thing saying what the numbers are worth, and it returns nothing when there
  // is nothing to say.
  const showUpstreamBadge =
    hasUpstreamDelta ||
    hasAuthFailedSignIn ||
    Boolean(worktree.fetchAuthFailed || worktree.fetchNetworkFailed) ||
    (!isDetached &&
      (worktree.baseBranchName != null ||
        worktree.lastFetchedAt != null ||
        worktree.worktreeChanges != null));

  // `tracking` is normalised to a string or null on every status pass, so a
  // null one with a snapshot present is a positive "no upstream configured",
  // not a not-yet. It says nothing about whether a remote branch exists —
  // `git push origin topic` without `-u` leaves one behind with no tracking
  // config — which is why neither the marker nor its tooltip claims one.
  const hasNoUpstream =
    !isDetached && worktree.worktreeChanges != null && !worktree.worktreeChanges.tracking;

  const prTier = showPRBadge
    ? computeAlarmTier({ ciState: worktree.linked?.pr?.ciStatus?.state }).tier
    : 0;
  const upstreamTier = computeAlarmTier({
    authFailed: hasAuthFailedSignIn,
    behindCount: worktree.behindCount,
    baseBehindCount: worktree.baseBehindCount,
  }).tier;
  const upstreamFirst = upstreamTier > prTier;
  const prHasAlarm = isPullRequestWarning(worktree.linked?.pr);
  const upstreamHasAlarm =
    upstreamTier > 0 || Boolean(worktree.fetchAuthFailed || worktree.fetchNetworkFailed);

  // The PR a worktree was created from leads this stack when a custom title
  // displaced it from the headline, and quiet keeps it only while it warns.
  const showSourcePrBadge =
    hasCustomTitle && isPrOriginated && Boolean(sourcePrNumber) && (!quietGit || prHasAlarm);

  const prBadge =
    showPRBadge && (!quietGit || prHasAlarm) ? (
      <PRBadge
        prNumber={worktree.linked!.pr!.ref.number}
        prState={worktree.linked!.pr!.state}
        prCiStatus={worktree.linked!.pr!.ciStatus}
        mergeIntent={worktree.linked!.pr!.mergeIntent}
        headMovedWhileArmed={worktree.linked!.pr!.headMovedWhileArmed}
        isSubordinate={!isCompact && !!worktree.issueNumber}
        worktreePath={worktree.path}
        onOpen={badges.onOpenPR}
        isActive={isActive}
        underlineOnHover={underlineOnHover}
        prDetectionPaused={prDetectionPaused}
      />
    ) : null;

  // On the compact card the sync line is ambient: how far a branch has drifted is
  // worth knowing when deciding to rebase, not every time the eye passes the
  // card. It lives at the top of Details there, and only a failed fetch or
  // sign-in (something to act on) keeps it on the card.
  const upstreamFailed =
    hasAuthFailedSignIn || Boolean(worktree.fetchAuthFailed || worktree.fetchNetworkFailed);
  const showSidebarUpstream = isCompact && showUpstreamBadge && upstreamFailed;
  const upstreamOutranksPr = showSidebarUpstream && upstreamFirst && prBadge !== null;
  const sharedRowPr = upstreamOutranksPr ? null : prBadge;
  const upstreamBadge =
    showUpstreamBadge && (isCompact ? upstreamFailed : !quietGit || upstreamHasAlarm) ? (
      <UpstreamSyncBadge
        aheadCount={worktree.aheadCount}
        behindCount={worktree.behindCount}
        isFetchInFlight={Boolean(worktree.isFetchInFlight)}
        lastFetchedAt={worktree.lastFetchedAt}
        fetchAuthFailed={Boolean(worktree.fetchAuthFailed)}
        fetchNetworkFailed={Boolean(worktree.fetchNetworkFailed)}
        hasAuthFailedSignIn={hasAuthFailedSignIn}
        containerGapClass="gap-1.5"
        baseBranchName={worktree.baseBranchName}
        baseAheadCount={worktree.baseAheadCount}
        baseBehindCount={worktree.baseBehindCount}
        baseMatchesUpstream={worktree.baseMatchesUpstream}
        baseCompareRef={worktree.baseCompareRef}
        hasNoUpstream={hasNoUpstream}
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
    // px-1: the block used to sit flush against the content column while the
    // disclosure rows below it carry a 7px leading inset, so the one part of
    // the card with no inset at all was the part with the most lines in it —
    // it read as pushed left and crowded against both edges. Four is half the
    // wells' inset on purpose: headline flush, its supporting lines stepped in
    // slightly, wells stepped in further. A progression down the card, rather
    // than one tier that missed the memo.
    // empty:hidden — the header mounts this row whenever the sync line might
    // have something to say, and the badge decides whether it does; a row
    // whose every child rendered nothing must not leave its margin behind.
    // The comfortable sidebar card spaces its lines 4px apart rather than 2px:
    // with the sync line and the PR back on lines of their own, four lines at
    // 2px read as one block of mono text instead of four facts.
    <div
      className={cn(
        "flex flex-col px-1 empty:hidden",
        isCompact ? "mt-1 gap-0.5" : isSidebar ? "mt-1.5 gap-1" : "mt-2.5 gap-0.5"
      )}
    >
      {showSourcePrBadge && (
        <PRBadge
          prNumber={sourcePrNumber!}
          prTitle={worktree.linked?.pr?.title ?? worktree.prTitle}
          prState={worktree.linked?.pr?.state}
          prCiStatus={worktree.linked?.pr?.ciStatus}
          mergeIntent={worktree.linked?.pr?.mergeIntent}
          headMovedWhileArmed={worktree.linked?.pr?.headMovedWhileArmed}
          isSubordinate={false}
          worktreePath={worktree.path}
          onOpen={badges.onOpenPR}
          isActive={isActive}
          underlineOnHover={underlineOnHover}
          prDetectionPaused={prDetectionPaused}
        />
      )}
      {!quietGit &&
        worktree.issueNumber &&
        (isPrOriginated || !hasDisplayTitle || hasCustomTitle) && (
          <IssueBadge
            issueNumber={worktree.issueNumber}
            issueTitle={issueBadgeTitle}
            provenance={worktree}
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
      {isCompact ? (
        <>
          {/* One identity row: the branch, with its pull request in a trailing
              slot, so the PR and its CI mark land in the same column on every
              card instead of on a line of their own. */}
          {((!quietGit && (hasDisplayTitle || hasCustomTitle)) || sharedRowPr) && (
            <div className="flex min-w-0 items-center gap-3">
              {!quietGit && (hasDisplayTitle || hasCustomTitle) && (
                <div className="min-w-0 flex-1">
                  <BranchLabel label={branchLabel} isActive={isActive} isMuted={isMuted} />
                </div>
              )}
              {sharedRowPr && <div className="shrink-0">{sharedRowPr}</div>}
            </div>
          )}
          {upstreamBadge}
          {/* When the failed fetch outranks the PR's state, the alarm order
              wins over the shared row: branch, then the failure, then the PR. */}
          {upstreamOutranksPr && prBadge}
        </>
      ) : (
        <>
          {!quietGit && (hasDisplayTitle || hasCustomTitle) && (
            <BranchLabel label={branchLabel} isActive={isActive} isMuted={isMuted} />
          )}
          {/* The comfortable card keeps one order, branch → PR → sync, so each
              fact stays on the line the eye learned for it; urgency goes to the
              title row's attention column instead of reordering the stack. */}
          {isSidebar ? prBadge : upstreamFirst ? upstreamBadge : prBadge}
          {isSidebar ? upstreamBadge : upstreamFirst ? prBadge : upstreamBadge}
        </>
      )}
      {hasPlanFile && badges.onOpenPlan && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Drawn on the branch line's grid: the same 14px glyph column and
                gap, so the filename starts where the branch name does, and the
                same 2xs mono, so the least important line in the stack is not
                its largest. w-fit keeps the hit target and the focus ring on
                the filename rather than the whole card width. The ring is the
                inset recipe drawn on padding that a matching negative margin
                cancels, so it clears the content without moving the rail; the
                top pad is only the ring's width, so it clears the sync line
                above. */}
            <button
              type="button"
              onClick={() => {
                if (isActive) badges.onOpenPlan?.();
              }}
              data-no-dnd
              className="group flex items-center gap-1.5 w-fit max-w-full min-w-0 -mx-1.5 px-1.5 -mt-0.5 pt-0.5 -mb-1.5 pb-1.5 text-left cursor-pointer rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              // Not aria-disabled on an unselected card: the click is not
              // refused, it selects the card, so the name says that instead.
              aria-label={
                isActive
                  ? `Open plan file ${planFileName}`
                  : `Select worktree, then open plan file ${planFileName}`
              }
            >
              <FileText
                className="w-3.5 h-3.5 shrink-0 text-text-secondary"
                strokeWidth={2.5}
                aria-hidden="true"
              />
              <span
                className={cn(
                  // Secondary even on a muted card: the row still operates
                  // there, and text-muted has no dark-theme contrast floor.
                  "truncate font-mono text-2xs font-medium text-text-secondary transition-colors duration-150",
                  // Only a card that opens the file on this click answers the
                  // hover; an unselected card's first click selects the card.
                  isActive && "group-hover:text-text-primary",
                  underlineOnHover && "group-hover:underline"
                )}
              >
                {planFileName}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            <div>Open {planFileName} in the file viewer</div>
            <div className="text-text-secondary">
              {isActive ? "Plan file in this worktree" : "Select the worktree first"}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

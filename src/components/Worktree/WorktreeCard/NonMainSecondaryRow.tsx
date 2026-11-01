import { cn } from "@/lib/utils";
import { BranchLabel } from "../BranchLabel";
import { syncLineHasNews } from "./syncLineNews";
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
  /** Names the worktree in its references' accessible names. */
  worktreeLabel?: string;
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
   * per fact, with an issue and its PR counted as one.
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
  worktreeLabel,
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

  const prTier =
    showPRBadge || isPrOriginated
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

  // The PR a worktree was created from, as a reference of its own: the
  // headline shows its title as words and never opens it (#15864). It leads
  // this stack when a custom title displaced it, carrying that title, and
  // otherwise takes the slot a linked PR takes on any other card. Quiet keeps
  // it only while it warns.
  const sourcePrBadge =
    isPrOriginated && Boolean(sourcePrNumber) && (!quietGit || prHasAlarm) ? (
      <PRBadge
        prNumber={sourcePrNumber!}
        prTitle={hasCustomTitle ? (worktree.linked?.pr?.title ?? worktree.prTitle) : undefined}
        prState={worktree.linked?.pr?.state}
        prCiStatus={worktree.linked?.pr?.ciStatus}
        mergeIntent={worktree.linked?.pr?.mergeIntent}
        headMovedWhileArmed={worktree.linked?.pr?.headMovedWhileArmed}
        isSubordinate={false}
        worktreePath={worktree.path}
        onOpen={badges.onOpenPR}
        worktreeLabel={worktreeLabel}
        prDetectionPaused={prDetectionPaused}
      />
    ) : null;

  const prBadge = isPrOriginated ? (
    hasCustomTitle ? null : (
      sourcePrBadge
    )
  ) : showPRBadge && (!quietGit || prHasAlarm) ? (
    <PRBadge
      prNumber={worktree.linked!.pr!.ref.number}
      prState={worktree.linked!.pr!.state}
      prCiStatus={worktree.linked!.pr!.ciStatus}
      mergeIntent={worktree.linked!.pr!.mergeIntent}
      headMovedWhileArmed={worktree.linked!.pr!.headMovedWhileArmed}
      // The sidebar draws the PR on the stack's own rail; the ↳ hook put a
      // second glyph and a fifth left edge in front of it.
      isSubordinate={!isSidebar && !!worktree.issueNumber}
      worktreePath={worktree.path}
      onOpen={badges.onOpenPR}
      worktreeLabel={worktreeLabel}
      prDetectionPaused={prDetectionPaused}
    />
  ) : null;

  // The issue is reachable from its own reference on every card that has one,
  // the card whose headline is that issue's title included — the headline is
  // words now, so this is where the issue opens from (#15864). On a compact
  // card that headline's reference is one number, so it rides the identity
  // row's trailing slot beside the PR rather than spending a line.
  const isIssueHeadline = hasDisplayTitle && !isPrOriginated && !hasCustomTitle;
  // The comfortable card gives a bare issue reference the line its PR takes,
  // under the branch: an issue and its pull request are one pair, and the
  // branch between them read as two unrelated facts. Only a reference that
  // carries a displaced title keeps a line of its own above the branch.
  const issueSharesLine = isCompact ? isIssueHeadline : isSidebar && !issueBadgeTitle;
  const issueBadge =
    !quietGit && worktree.issueNumber ? (
      <IssueBadge
        issueNumber={worktree.issueNumber}
        issueTitle={issueBadgeTitle}
        provenance={worktree}
        worktreePath={worktree.path}
        onOpen={badges.onOpenIssue}
        worktreeLabel={worktreeLabel}
        hoverCardSide={issueSharesLine && prBadge ? "top" : "right"}
      />
    ) : null;
  const trailingIssueBadge = isCompact && isIssueHeadline ? issueBadge : null;
  const referenceRowIssue = !isCompact && issueSharesLine ? issueBadge : null;
  const stackIssueBadge = trailingIssueBadge || referenceRowIssue ? null : issueBadge;

  // On the compact card the sync line is ambient: how far a branch has drifted is
  // worth knowing when deciding to rebase, not every time the eye passes the
  // card. It lives at the top of Details there, and only a failed fetch or
  // sign-in (something to act on) keeps it on the card.
  const upstreamFailed =
    hasAuthFailedSignIn || Boolean(worktree.fetchAuthFailed || worktree.fetchNetworkFailed);
  const showSidebarUpstream = isCompact && showUpstreamBadge && upstreamFailed;
  const upstreamOutranksPr = showSidebarUpstream && upstreamFirst && prBadge !== null;
  const sharedRowPr = upstreamOutranksPr ? null : prBadge;
  // The comfortable card gives the sync line its own row only when it has
  // news, drift or a failure, the way the PR row appears only when there is a
  // PR: "level with develop, no upstream" on every idle card taught the eye to
  // skip the row that later carried real drift. Details keeps the quiet form.
  const syncHasNews = syncLineHasNews(worktree);
  const upstreamBadge =
    showUpstreamBadge &&
    (isCompact
      ? upstreamFailed
      : isSidebar
        ? syncHasNews && (!quietGit || upstreamHasAlarm)
        : !quietGit || upstreamHasAlarm) ? (
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

  // Compact keeps upstream drift on the identity row, at no height: unpushed
  // or diverged commits are a decision fact, and Details is one click too far
  // to compare cards by. Base drift and the quiet states stay in Details.
  const compactDrift =
    isCompact &&
    !quietGit &&
    !upstreamFailed &&
    ((worktree.aheadCount ?? 0) > 0 || (worktree.behindCount ?? 0) > 0) ? (
      <UpstreamSyncBadge
        aheadCount={worktree.aheadCount}
        behindCount={worktree.behindCount}
        isFetchInFlight={false}
        lastFetchedAt={worktree.lastFetchedAt}
        fetchAuthFailed={false}
        fetchNetworkFailed={false}
        hasAuthFailedSignIn={false}
        containerGapClass="gap-1"
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
      {hasCustomTitle && sourcePrBadge}
      {stackIssueBadge}
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
          {((!quietGit && (hasDisplayTitle || hasCustomTitle)) ||
            sharedRowPr ||
            compactDrift ||
            trailingIssueBadge) && (
            // Stacked below 20rem, where a PR beside the branch left the
            // branch about 14 characters.
            <div className="flex min-w-0 flex-col gap-0.5 @xs/card:flex-row @xs/card:items-center @xs/card:gap-3">
              {!quietGit && (hasDisplayTitle || hasCustomTitle) && (
                <div className="min-w-0 flex-1">
                  <BranchLabel label={branchLabel} isActive={isActive} isMuted={isMuted} />
                </div>
              )}
              {(compactDrift || sharedRowPr || trailingIssueBadge) && (
                // Wraps only where the row has stacked below 20rem and the
                // group has the card's width to itself; beside the branch it
                // keeps its own width and the branch gives way.
                <div className="flex max-w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
                  {compactDrift}
                  {trailingIssueBadge}
                  {sharedRowPr}
                </div>
              )}
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
          {/* The comfortable card keeps one order, branch → issue and PR → sync,
              so each fact stays on the line the eye learned for it; urgency goes
              to the title row's attention column instead of reordering the stack. */}
          {isSidebar
            ? (referenceRowIssue || prBadge) && (
                // Each reference keeps its own target. When the card is too
                // narrow for both, the PR wraps whole, its marks with it,
                // rather than either number truncating; the row gap keeps the
                // targets' vertical extensions from meeting across the wrap.
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  {referenceRowIssue}
                  {prBadge}
                </div>
              )
            : upstreamFirst
              ? upstreamBadge
              : prBadge}
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
              // The viewer is a dialog naming this worktree's root, so it
              // opens from any card without selecting it first (#11942).
              onClick={() => badges.onOpenPlan?.()}
              data-no-dnd
              className="group flex items-center gap-1.5 w-fit max-w-full min-w-0 -mx-1.5 px-1.5 -mt-0.5 pt-0.5 -mb-1.5 pb-1.5 text-left cursor-pointer rounded-[var(--radius-sm)] transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              aria-label={`Open plan file ${planFileName}${worktreeLabel ? ` for worktree ${worktreeLabel}` : ""}`}
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
                  "truncate font-mono text-2xs font-medium text-text-secondary transition-colors duration-150 group-hover:text-text-primary group-hover:underline"
                )}
              >
                {planFileName}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            <div>Open {planFileName} in the file viewer</div>
            <div className="text-text-secondary">Plan file in this worktree</div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

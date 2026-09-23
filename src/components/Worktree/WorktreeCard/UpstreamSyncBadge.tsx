import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { actionService } from "@/services/ActionService";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { ClockAlert, CloudOff, KeyRound } from "@/components/icons";
import type { LucideIcon } from "lucide-react";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";

interface UpstreamSyncBadgeProps {
  aheadCount: number | undefined;
  behindCount: number | undefined;
  isFetchInFlight: boolean;
  lastFetchedAt: number | null | undefined;
  fetchAuthFailed: boolean;
  fetchNetworkFailed: boolean;
  hasAuthFailedSignIn: boolean;
  /** Provider whose settings the sign-in affordance routes to; null hides nothing but routes to the tab root. */
  authProviderId?: string | null;
  containerGapClass: string;
  baseBranchName?: string | null;
  baseAheadCount?: number | null;
  baseBehindCount?: number | null;
  baseMatchesUpstream?: boolean;
  /**
   * Ref the base counts were measured against (`upstream/main`). Named in the
   * tooltip while the compact pill keeps the bare branch name — the pill is
   * scanned across a dozen cards, the tooltip is where the disambiguation
   * belongs.
   */
  baseCompareRef?: string | null;
  /**
   * True when the branch has no upstream configured. Since `87dc51fa9` stopped
   * pointing fresh topic branches at their base, this is the normal state of
   * every worktree between creation and its first push, so the line has to be
   * able to say it rather than just showing nothing.
   *
   * It is "no upstream", not "never pushed": `git push origin topic` without
   * `-u` leaves a remote branch behind with no tracking config, and so does
   * `git branch --unset-upstream`. The tooltip says the configured thing;
   * only the compact marker abbreviates.
   */
  hasNoUpstream?: boolean;
  fetchIntervalMs?: number;
}

const STALENESS_MULTIPLIER = 1.5;
const FLASH_DURATION_MS = 250;

export function UpstreamSyncBadge({
  aheadCount,
  behindCount,
  isFetchInFlight,
  lastFetchedAt,
  fetchAuthFailed,
  fetchNetworkFailed,
  hasAuthFailedSignIn,
  authProviderId,
  containerGapClass,
  baseBranchName,
  baseAheadCount,
  baseBehindCount,
  baseMatchesUpstream,
  baseCompareRef,
  hasNoUpstream,
  fetchIntervalMs,
}: UpstreamSyncBadgeProps) {
  const hasAhead = aheadCount !== undefined && aheadCount > 0;
  const hasBehind = behindCount !== undefined && behindCount > 0;
  const hasBaseAhead = baseAheadCount != null && baseAheadCount > 0;
  const hasBaseBehind = baseBehindCount != null && baseBehindCount > 0;

  // The base segment is a *relationship*, not an alarm: it renders whenever we
  // know which branch this one is measured against, and only its glyph and
  // counts change with the state. Gating the whole line on a non-zero count —
  // what it used to do — meant a worktree sitting exactly on its base with no
  // upstream yet said nothing at all about where it came from, which is the
  // state every worktree is in the moment it is created.
  const hasBaseName = baseBranchName != null;
  // `BaseDivergence` tries the remote compare ref first and falls back to the
  // LOCAL base branch when that ref won't resolve — which is exactly what
  // "Fetch and prune" leaves behind when the base branch is gone from the
  // remote (#12091). The fallback is observable here because the fallback ref
  // is the bare branch name where a healthy compare is `remote/branch`, so the
  // tooltip can say the counts are local rather than passing them off as
  // measured against the remote.
  //
  // What it must NOT say is WHY. The same fallback covers a pruned-away ref, a
  // repo with no remote at all, and a transient git error, and the renderer
  // cannot tell them apart — so the copy reports the comparison it got, not a
  // cause it did not observe.
  const comparedWithLocalBase =
    hasBaseName && baseCompareRef != null && baseCompareRef === baseBranchName;
  // `||`, not `??`: an empty-string compare ref has to fall through to the
  // branch name the same way it always did, or the tooltip renders "behind ".
  const compareLabel = comparedWithLocalBase
    ? `local ${baseBranchName}`
    : baseCompareRef || baseBranchName;
  const showBaseDivergence = hasBaseName && (hasBaseAhead || hasBaseBehind);
  // Equality has to be measured, not assumed. `BaseDivergence` keeps the base
  // name and nulls a count it could not parse, so a missing count is "we do
  // not know", and the resting form is the one claim we cannot make on a
  // guess — it says the two are the same commit.
  const baseCountsKnown = baseAheadCount != null && baseBehindCount != null;

  // A branch can end up tracking its own base — `git worktree add -b topic
  // --track origin/develop` writes `branch.topic.merge = refs/heads/develop`,
  // and any branch may be pointed at an integration branch by hand. Then
  // `@{u}` and the base compare ref are the same commit, both pairs carry the
  // same number, and only one of them says what the number is counted against.
  //
  // Drop the unlabelled pair, never the label. The old rule did the reverse,
  // so two worktrees on the same commit off the same base rendered as
  // `Δ develop ↓4` and a bare `↓4` purely on how their tracking config
  // happened to be written — and a bare `↓4` beside a labelled one reads as a
  // different measurement, not the same one.
  //
  // Gated on the base pair actually being non-zero so an inter-pass race that
  // zeroes the base counts while upstream still reports drift falls back to
  // the upstream form rather than rendering nothing.
  const dedupeToBase = baseMatchesUpstream === true && showBaseDivergence;
  const showUpstreamDelta = (hasAhead || hasBehind) && !dedupeToBase;

  // That same race is the one state where the resting form must not appear.
  // `baseMatchesUpstream` says @{u} and the base compare ref are the same
  // commit, so the two pairs are one measurement — and `↓4 ≡ develop` would
  // have the halves contradicting each other about it. The upstream pair is
  // the fresher of the two there (git status runs every pass; the base counts
  // can be served from their stat-keyed cache), so it keeps the line and the
  // equality claim stands down. Where the two refs genuinely differ,
  // `↑3 ≡ develop` is not a contradiction and renders as it reads: three
  // commits the remote branch has not got, none that develop has not got.
  const showBaseResting =
    hasBaseName &&
    baseCountsKnown &&
    !showBaseDivergence &&
    !(baseMatchesUpstream === true && showUpstreamDelta);
  const showBaseSegment = showBaseDivergence || showBaseResting;

  // Flash only on changes the user can actually see — track display-gated
  // values so a null→0 transition on hidden base counts doesn't flash, and
  // a baseMatchesUpstream flip that moves the counts between the two forms
  // does.
  const displayedAhead = showUpstreamDelta && hasAhead ? aheadCount : null;
  const displayedBehind = showUpstreamDelta && hasBehind ? behindCount : null;
  const displayedBaseAhead = showBaseDivergence && hasBaseAhead ? baseAheadCount : null;
  const displayedBaseBehind = showBaseDivergence && hasBaseBehind ? baseBehindCount : null;

  const prevDisplayedRef = useRef({
    displayedAhead,
    displayedBehind,
    displayedBaseAhead,
    displayedBaseBehind,
  });
  const [isFlashing, setIsFlashing] = useState(false);

  useEffect(() => {
    const prev = prevDisplayedRef.current;
    const changed =
      prev.displayedAhead !== displayedAhead ||
      prev.displayedBehind !== displayedBehind ||
      prev.displayedBaseAhead !== displayedBaseAhead ||
      prev.displayedBaseBehind !== displayedBaseBehind;
    prevDisplayedRef.current = {
      displayedAhead,
      displayedBehind,
      displayedBaseAhead,
      displayedBaseBehind,
    };
    if (!changed) return;
    setIsFlashing(true);
    const safetyTimer = window.setTimeout(() => setIsFlashing(false), FLASH_DURATION_MS);
    return () => window.clearTimeout(safetyTimer);
  }, [displayedAhead, displayedBehind, displayedBaseAhead, displayedBaseBehind]);

  // Staleness is a function of the clock, not of the props: a fetch that keeps
  // failing leaves `lastFetchedAt` exactly where it was, so a check keyed only
  // on the props froze at "fresh" on precisely the card that most needed to
  // say otherwise. The shared minute clock re-reads it as time passes.
  const nowMs = useGlobalMinuteClock();
  const isStale =
    lastFetchedAt != null &&
    fetchIntervalMs != null &&
    nowMs - lastFetchedAt > fetchIntervalMs * STALENESS_MULTIPLIER;

  const handleSignInClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      // Auth failures suspend background fetches indefinitely (#9736). Clearing the
      // suspension and re-fetching only happens on an explicit user action, so kick
      // it off here — fire-and-forget, the settings tab below is the recovery path
      // if the token still needs fixing.
      safeFireAndForget(window.electron.worktree.retryAuthFetch(), {
        context: "Retry auth-suspended fetch from sync badge",
      });
      void actionService.dispatch(
        "app.settings.openTab",
        authProviderId ? { tab: "code-forge", subtab: authProviderId } : { tab: "code-forge" },
        { source: "user" }
      );
    },
    [authProviderId]
  );

  const isAuthActionable = fetchAuthFailed && hasAuthFailedSignIn;

  // One mark at the end of the line says whether the counts can be trusted.
  // It replaces the opacity fades this line used to use for the same job: a
  // faded line reads as disabled rather than as doubtful, the fades stacked to
  // near-invisible when a failed fetch also went stale, and lightness alone is
  // not a channel anyone can tell apart at a glance. Worst first, so a line
  // never carries two: an auth failure is the only one the user has to act on,
  // an unreachable remote explains the staleness that always comes with it,
  // and plain staleness is what is left. A fetch in flight does not clear it —
  // the counts are exactly as old as they were until the answer lands.
  const status: SyncStatus | null = isAuthActionable
    ? "auth"
    : fetchNetworkFailed
      ? "unreachable"
      : isStale
        ? "stale"
        : null;
  const StatusIcon = status ? STATUS_ICONS[status] : null;
  // Nothing to say, and nothing wrong with saying nothing. A degraded fetch
  // still earns a mark with no counts beside it: on the main card an empty
  // line reads as "in sync", which is the one claim a failed fetch cannot make.
  if (!showUpstreamDelta && !showBaseSegment && status === null) return null;

  const upstreamSentence = showUpstreamDelta
    ? `Upstream: ${describeDrift(hasAhead ? aheadCount : 0, hasBehind ? behindCount : 0)}`
    : null;
  // Label first, ref once, in the collapsed alarm pill's own formula
  // (`formatAlarmDetail`): the old `2 ahead of origin/develop, 7 behind
  // origin/develop` named the ref twice and put it last, where it was the part
  // most likely to wrap. Ahead before behind here, matching ↑ ↓ on the line.
  const baseSentence =
    showBaseDivergence && compareLabel
      ? `Base (${compareLabel}): ${describeDrift(baseAheadCount ?? 0, baseBehindCount ?? 0)}`
      : showBaseResting && compareLabel
        ? `Base (${compareLabel}): in sync`
        : null;
  const noUpstream = hasNoUpstream === true && showBaseSegment;
  const statusSentence =
    status === "unreachable"
      ? "Couldn't reach the remote"
      : status === "stale"
        ? "Counts may be out of date"
        : null;
  const accessibleSummary = [
    statusSentence,
    upstreamSentence,
    baseSentence,
    noUpstream ? "No upstream branch configured" : null,
  ]
    .filter(Boolean)
    .join(". ");

  const line = (
    <>
      {showUpstreamDelta && hasAhead && (
        <span className="text-status-success shrink-0">↑{aheadCount}</span>
      )}
      {showUpstreamDelta && hasBehind && (
        <span className="text-status-warning shrink-0">↓{behindCount}</span>
      )}
      {showBaseSegment && (
        <>
          {/* `text-secondary`, not `text-muted`: this names the branch the
              counts beside it are counted against, so it is the only thing
              that makes them mean anything, and `text-muted` has no contrast
              floor on the darkest palettes. The line is 11px under two
              brighter rows; that is where its de-emphasis comes from.

              Δ means drift, so it cannot carry the resting state: ≡ says the
              two are the same commit, which is the whole content of the
              resting line.

              The only thing on this line allowed to shrink. Everything beside
              it is shrink-0, so a base branch long enough to outgrow the card
              ellipsizes here instead of pushing the counts and the marks off
              the right edge, and the tooltip still names it in full. Glyph and
              name stay one text run so the ellipsis eats the name. */}
          <span className="text-text-secondary min-w-0 truncate" data-testid="upstream-sync-base">
            {showBaseDivergence ? "Δ" : "≡"} {baseBranchName}
          </span>
          {displayedBaseAhead != null && (
            <span className="text-status-success shrink-0">↑{displayedBaseAhead}</span>
          )}
          {displayedBaseBehind != null && (
            <span className="text-status-warning shrink-0">↓{displayedBaseBehind}</span>
          )}
          {/* Same tier as the branch name it qualifies — never text-muted. */}
          {hasNoUpstream && (
            <span className="text-text-secondary shrink-0" data-testid="upstream-sync-unpushed">
              · local
            </span>
          )}
        </>
      )}
      {StatusIcon && status && (
        <StatusIcon
          className={cn("w-3 h-3 shrink-0", STATUS_TONES[status])}
          data-testid="upstream-sync-status"
          data-status={status}
          aria-hidden="true"
        />
      )}
    </>
  );

  // Both variants explain themselves with the same body, so a truncated name,
  // the counts and the fetch state read the same whichever one is showing.
  const lastFetched =
    lastFetchedAt != null
      ? formatRelativeTime(lastFetchedAt, Math.max(nowMs, lastFetchedAt))
      : null;
  const detail = (
    <>
      {/* The qualification comes before the counts it qualifies: read in the
          other order, the numbers have already been believed. */}
      {statusSentence && (
        <div
          className={status === "unreachable" ? "text-status-warning" : undefined}
          data-testid={status === "unreachable" ? "upstream-sync-network-warning" : undefined}
        >
          {statusSentence}
        </div>
      )}
      {upstreamSentence && <div>{upstreamSentence}</div>}
      {baseSentence && <div className="break-words">{baseSentence}</div>}
      <div className="mt-1 text-text-secondary empty:hidden">
        {comparedWithLocalBase && showBaseSegment && (
          <div data-testid="upstream-sync-local-base">Remote comparison unavailable</div>
        )}
        {noUpstream && <div>No upstream branch configured</div>}
        {isFetchInFlight ? (
          <div>Fetching now</div>
        ) : lastFetched ? (
          <div>Last fetched {lastFetched}</div>
        ) : null}
      </div>
    </>
  );

  if (isAuthActionable) {
    return (
      // autoDismiss={false}: the pill can ellipsize the base name, so this
      // tooltip is the only place to read it in full — a full-text reveal,
      // which `tooltip.tsx` exempts from the 2.5s deadline meant for hints.
      <Tooltip autoDismiss={false}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleSignInClick}
            data-no-dnd
            className="group flex items-center w-fit max-w-full min-w-0 text-left text-3xs font-mono tabular-nums cursor-pointer rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            data-testid="upstream-sync-indicator"
            data-fetch-auth-failed="true"
            aria-label={`Forge authentication failed — click to reconnect${
              accessibleSummary ? `. ${accessibleSummary}` : ""
            }`}
          >
            {/* min-w-0: this row is a flex *item* of the button above it, so
                its own automatic minimum size is its min-content width — the
                whole unbroken branch name, since the label sets white-space:
                nowrap. Without this the row refuses to shrink and the label
                never gets narrow enough to ellipsize. */}
            <span className={cn("flex items-center min-w-0", containerGapClass)}>
              {line}
              {/* The verb is what makes a line of metadata read as a control.
                  shrink-0 with the counts: a long base name gives way first. */}
              <span className="text-status-warning shrink-0 font-sans group-hover:underline">
                Reconnect
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          <div>Forge authentication failed</div>
          <div className="mb-1 text-text-secondary">Click to reconnect your code forge</div>
          {detail}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    // Same full-text reveal as the auth-failed variant above.
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        {/* A tab stop, like the PR and issue badges beside it: the compare
            ref, the freshness and a clipped base name exist only in the
            tooltip, so a trigger keyboard focus cannot reach leaves them to
            the pointer alone. role="img" + the summary as its name, because
            the glyph run on its own is spoken as "upwards arrow one, Greek
            capital letter delta". */}
        <span
          role="img"
          tabIndex={0}
          aria-label={accessibleSummary}
          className={cn(
            "flex items-center w-fit max-w-full text-3xs font-mono tabular-nums rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            containerGapClass,
            isFlashing && "animate-upstream-badge-flash"
          )}
          data-testid="upstream-sync-indicator"
          data-fetch-in-flight={isFetchInFlight ? "true" : undefined}
          data-fetch-network-failed={fetchNetworkFailed ? "true" : undefined}
          data-stale={isStale ? "true" : undefined}
          onAnimationEnd={() => setIsFlashing(false)}
        >
          {line}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}

type SyncStatus = "auth" | "unreachable" | "stale";

// The app's own vocabulary for each: KeyRound is what the collapsed alarm pill
// already shows for broken forge credentials, CloudOff what the PR and issue
// badges show when the forge is out of reach.
const STATUS_ICONS: Record<SyncStatus, LucideIcon> = {
  auth: KeyRound,
  unreachable: CloudOff,
  stale: ClockAlert,
};

// Warning only for the one the user has to act on. The other two recover on
// their own, so they sit at the branch name's tier and do not compete with the
// ↓ counts, which are the line's warning-toned news.
const STATUS_TONES: Record<SyncStatus, string> = {
  auth: "text-status-warning",
  unreachable: "text-text-secondary",
  stale: "text-text-secondary",
};

function describeDrift(ahead: number, behind: number): string {
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  if (ahead > 0 && behind > 0) return `${commits(ahead)} ahead, ${behind} behind`;
  if (ahead > 0) return `${commits(ahead)} ahead`;
  return `${commits(behind)} behind`;
}

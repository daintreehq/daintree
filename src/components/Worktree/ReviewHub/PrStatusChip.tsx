import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ExternalLink, GitPullRequest } from "lucide-react";
import { GitMerge } from "@/components/icons";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import type { CIStatus, NormalizedPRState, PRMergeIntent } from "@shared/types/forge";
import {
  describeMergeIntent,
  HEAD_MOVED_WHILE_ARMED_TEXT,
  mergeIntentLabel,
  mergeMethodLabel,
} from "@shared/utils/prMergeIntent";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import { PrChecksPopover } from "./PrChecksPopover";
import {
  applyMergeOutcome,
  describeMergeOutcome,
  isMergeOutcomeReflected,
  type PrMergeOutcome,
} from "./prMergeModel";

/**
 * How long the acknowledgement beside the chip stays after a merge, arm or
 * cancel. Long enough to be read once the confirm's exit has finished and the
 * eye is back on the chip; it is a confirmation, so it clears on its own.
 */
const MERGE_ACK_DWELL_MS = 6_000;

/**
 * How long GitHub's reply to a write stands in for detection. The chip shows
 * what the reply said until a detection pass reports the same, and gives way
 * to detection after this however it reads — the reply is a snapshot too.
 */
const MERGE_OUTCOME_HOLD_MS = 30_000;

interface WorktreePR {
  prNumber: number;
  prUrl: string;
  prState: NormalizedPRState;
  prCiStatus?: CIStatus;
  mergeIntent?: PRMergeIntent | null;
  headMovedWhileArmed?: boolean;
}

interface PrStatusChipProps {
  hasRemote: boolean | undefined;
  worktreePR: WorktreePR | null;
  worktreePath: string;
  onOpenExternal: (url: string) => void;
}

export function PrStatusChip({
  hasRemote,
  worktreePR,
  worktreePath,
  onOpenExternal,
}: PrStatusChipProps) {
  // Keyed to the PR it was for: a reply about one pull request never paints
  // over another that takes the chip's place.
  const [stored, setStored] = useState<{ identity: string; outcome: PrMergeOutcome } | null>(null);
  const [ackVisible, setAckVisible] = useState(false);
  const identity = worktreePR ? `${worktreePath}:${worktreePR.prNumber}:${worktreePR.prUrl}` : null;
  const outcome = stored && stored.identity === identity ? stored.outcome : null;

  useEffect(() => {
    if (!ackVisible) return;
    const timer = setTimeout(() => setAckVisible(false), MERGE_ACK_DWELL_MS);
    return () => clearTimeout(timer);
  }, [ackVisible, outcome]);

  useEffect(() => {
    if (!stored) return;
    const timer = setTimeout(() => setStored(null), MERGE_OUTCOME_HOLD_MS);
    return () => clearTimeout(timer);
  }, [stored]);

  const handleMergeOutcome = useCallback(
    (next: PrMergeOutcome) => {
      if (!identity) return;
      setStored({ identity, outcome: next });
      setAckVisible(true);
    },
    [identity]
  );

  if (hasRemote && worktreePR && worktreePR.prUrl) {
    // Only an open PR can still merge; a stale intent on a merged one is noise.
    const detected = {
      prState: worktreePR.prState,
      mergeIntent: worktreePR.prState === "open" ? (worktreePR.mergeIntent ?? null) : null,
    };
    const shown =
      outcome && !isMergeOutcomeReflected(outcome, detected)
        ? applyMergeOutcome(outcome, detected)
        : detected;
    const ciVisual = getCIStatusVisual(worktreePR.prCiStatus);
    const prStateLabel =
      shown.prState === "merged"
        ? "merged"
        : shown.prState === "closed" || shown.prState === "declined"
          ? "closed"
          : "open";
    const PrStateGlyph = getPrStateGlyph(shown.prState);
    const prStateColor = getPrStateColor(shown.prState);
    // The disclosure button is named by the words the badge shows, so a speech
    // user can say what they see at every width; the sentence spelling out
    // each state is its description.
    const mergeIntent = shown.prState === "open" ? shown.mergeIntent : null;
    const headMoved = mergeIntent !== null && worktreePR.headMovedWhileArmed === true;
    const mergeIntentText = mergeIntent
      ? ` — ${describeMergeIntent(mergeIntent)}${headMoved ? `. ${HEAD_MOVED_WHILE_ARMED_TEXT}` : ""}`
      : "";
    const triggerDescription = ciVisual
      ? `Pull request #${worktreePR.prNumber} ${prStateLabel} — CI ${ciVisual.shortLabel}${mergeIntentText}`
      : `Pull request #${worktreePR.prNumber} ${prStateLabel}${mergeIntentText}`;
    return (
      <>
        {/* Available whatever the roll-up says, including when it says nothing:
            an absent roll-up is not evidence that there are no checks. */}
        <PrChecksPopover
          // Identity key, not decoration: a snapshot read for one pull request
          // must never be repainted — or handed to an agent — under another's
          // number — and the URL is in it because two repositories can both have
          // a #42. Remounting is the only reset that cannot be half-applied.
          key={`${worktreePath}:${worktreePR.prNumber}:${worktreePR.prUrl}`}
          worktreePath={worktreePath}
          prNumber={worktreePR.prNumber}
          prUrl={worktreePR.prUrl}
          triggerDescription={triggerDescription}
          onOpenExternal={onOpenExternal}
          onMergeOutcome={handleMergeOutcome}
        >
          <Badge
            tone="outline"
            className={cn(
              "text-2xs font-mono transition-colors",
              "group-hover/pr-checks:bg-overlay-soft group-data-[state=open]/pr-checks:bg-overlay-soft"
            )}
          >
            {/* Shape AND colour — see `getPrStateGlyph`. This chip does carry the
              state word beside it, but the glyph is what the eye reaches
              first, and it is shared with the card badge, which does not. */}
            <PrStateGlyph className={cn("w-3 h-3 shrink-0", prStateColor)} aria-hidden="true" />
            <span className="sr-only">Pull request</span>
            {/* Words and the number stay neutral; the glyphs carry the state
                colour. Elsewhere a PR number wears its `pr-*` token, but that
                token is only contrast-gated on bare panels — on this chip's
                tinted fill a closed PR's red drops under 4.5:1 for small text,
                and status tokens only promise the 3:1 non-text floor. */}
            <span className="text-text-primary">#{worktreePR.prNumber}</span>
            {/* In a narrow review header the words step down before the branch
                beside the chip has to: the merge words first, then the state
                word the glyph already shows, then the CI word beside its
                glyph. Every one stays in the trigger's description and the
                checks popover. */}
            <span className="inline-flex items-center gap-1 @max-[640px]/header:hidden">
              <span className="text-text-muted" aria-hidden="true">
                ·
              </span>
              <span className="text-text-secondary">{prStateLabel}</span>
            </span>
            {ciVisual && (
              <>
                <span className="text-text-muted" aria-hidden="true">
                  ·
                </span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className="inline-flex items-center justify-center w-3 h-3 shrink-0"
                    aria-hidden="true"
                  >
                    {ciVisual.kind === "icon" ? (
                      <ciVisual.Icon className={cn("w-3 h-3", ciVisual.colorClass)} />
                    ) : (
                      <span
                        className={cn(
                          "status-mark block w-2 h-2 rounded-full",
                          ciVisual.colorClass
                        )}
                      />
                    )}
                  </span>
                  <span className="text-text-secondary @max-[520px]/header:hidden">
                    {ciVisual.shortLabel}
                  </span>
                </span>
              </>
            )}
            {mergeIntent && (
              <>
                <span className="text-text-muted" aria-hidden="true">
                  ·
                </span>
                <span className="inline-flex items-center gap-1" data-testid="pr-merge-intent">
                  {headMoved ? (
                    <AlertTriangle
                      className="w-3 h-3 shrink-0 text-status-warning"
                      aria-hidden="true"
                    />
                  ) : (
                    <GitMerge className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden="true" />
                  )}
                  {/* The method is its own segment, behind the chip's own separator,
                      rather than a dot typed inside one label. */}
                  <span className="text-text-secondary @max-[1100px]/header:hidden">
                    {mergeIntent.kind === "queued" ? mergeIntentLabel(mergeIntent) : "auto-merge"}
                  </span>
                </span>
                {mergeIntent.kind === "auto-merge" && mergeIntent.method && (
                  <span className="inline-flex items-center gap-1 @max-[1100px]/header:hidden">
                    <span className="text-text-muted" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-text-secondary" data-testid="pr-merge-intent-method">
                      {mergeMethodLabel(mergeIntent.method)}
                    </span>
                  </span>
                )}
              </>
            )}
            <span className="sr-only">show CI checks</span>
            <ChevronDown
              data-animated-chevron
              className="w-3 h-3 shrink-0 -mr-0.5 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]/pr-checks:rotate-180"
              aria-hidden="true"
            />
          </Badge>
        </PrChecksPopover>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onOpenExternal(worktreePR.prUrl)}
              // 24px target without growing the header row the chip sits in,
              // and never narrower: the branch beside it is what gives way.
              className="-my-1 shrink-0 transition-colors"
              aria-label={`View pull request #${worktreePR.prNumber}`}
            >
              <ExternalLink aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">View pull request #{worktreePR.prNumber}</TooltipContent>
        </Tooltip>
        {ackVisible && outcome && <MergeAck outcome={outcome} prNumber={worktreePR.prNumber} />}
      </>
    );
  }

  if (hasRemote && !worktreePR) {
    return (
      <Badge tone="outline" className="text-2xs text-text-secondary">
        <GitPullRequest />
        <span>No PR</span>
      </Badge>
    );
  }

  return null;
}

/**
 * The confirmation a write gets where the user is looking once the confirm
 * closes: beside the chip that focus returned to. Hidden from assistive tech
 * because the popover's status region says it.
 */
function MergeAck({ outcome, prNumber }: { outcome: PrMergeOutcome; prNumber: number }) {
  // Green only for a merge that landed or one GitHub now has armed; a
  // cancellation or an unconfirmed request is acknowledged without it.
  const landed = outcome.kind === "merged" || outcome.kind === "armed";
  const Glyph = outcome.kind === "not-pending" ? SEVERITY_GLYPH.info : SEVERITY_GLYPH.success;
  return (
    <span
      data-testid="pr-merge-ack"
      aria-hidden="true"
      className="inline-flex items-center gap-1 text-2xs text-text-secondary whitespace-nowrap"
    >
      <Glyph
        className={cn("w-3 h-3 shrink-0", landed ? "text-status-success" : "text-text-secondary")}
      />
      {describeMergeOutcome(outcome, prNumber).short}
    </span>
  );
}

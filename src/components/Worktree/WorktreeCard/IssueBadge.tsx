import { cn } from "@/lib/utils";
import { CircleDot, CloudOff } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useIssueTooltip } from "@/hooks/useForgeTooltip";
import { useForgeBadgeTooltip } from "./hooks/useForgeBadgeTooltip";
import { useColdNumberGap } from "./hooks/useColdNumberGap";
import { useForgeBadgeFreshness } from "./hooks/useForgeBadgeFreshness";
import { freshnessClass } from "@/components/Layout/FreshnessUtils";
import type { IssueProvenance } from "@shared/types/ipc/worktree";
import { worktreeIssueLinkTarget } from "@shared/utils/worktreeIssueProjection";
import {
  IssueTooltipContent,
  TokenMissingTooltip,
  describeIssueTooltip,
  TooltipFallback,
  HOVER_CARD_EVENT_FENCE,
  type TooltipFreshness,
} from "./ForgeTooltipContent";

interface IssueBadgeProps {
  issueNumber: number;
  issueTitle?: string;
  /**
   * Who owns `issueNumber` (#13744). Absent means the code forge's number;
   * the badge reads the issue from the link's own provider either way.
   */
  provenance?: IssueProvenance;
  worktreePath: string;
  onOpen?: () => void;
  /** Names the worktree the issue is linked to in the reference's accessible name. */
  worktreeLabel?: string;
}

export function IssueBadge({
  issueNumber,
  issueTitle,
  provenance,
  worktreePath,
  onOpen,
  worktreeLabel,
}: IssueBadgeProps) {
  const { data, loading, error, missingCredential, providerId, fetchTooltip, reset } =
    useIssueTooltip(worktreePath, issueNumber, worktreeIssueLinkTarget(provenance ?? {}));
  // A tracker's own identifier (`ENG-42`) when the link has one; its number
  // alone would read as the code forge's issue.
  const issueLabel = provenance?.issueKey ?? `#${issueNumber}`;
  const worktreeSuffix = worktreeLabel ? ` for worktree ${worktreeLabel}` : "";

  const { isOpen, handleOpenChange, handleClick } = useForgeBadgeTooltip({
    fetchTooltip,
    reset,
    missingCredential,
    providerId,
    onOpen,
  });

  // Suppress the raw "#NNN" monospace fallback during the brief window where
  // a *freshly-set* issue number has no title yet (the forge title fetch is
  // in-flight, ~100–500ms). Per the Doherty Threshold, show nothing for the
  // first 400ms rather than flashing the number, then fall through (#8079).
  // Title preservation for *unchanged* issue numbers is handled upstream in
  // the store, so this gate only fires on genuine issue-number transitions.
  const hideColdNumber = useColdNumberGap(issueNumber, issueTitle);

  const { freshnessLevel, freshnessCause, rateLimitResetAt, now } = useForgeBadgeFreshness("issue");

  const freshness: TooltipFreshness = { cause: freshnessCause, now, rateLimitResetAt };

  const showPausedGlyph = freshnessCause === "rate-limit" && !missingCredential;

  return (
    <Tooltip
      open={isOpen}
      onOpenChange={handleOpenChange}
      delayDuration={300}
      autoDismiss={false}
      // Rich hover card whose body IS the content — exempt from the global
      // dialog-transition dismissal (issue #11030).
      dismissOnDialogTransition={false}
      // The app-wide provider makes tooltip content pass-through. A card this
      // size must stay up while the pointer crosses onto it to read it (WCAG
      // SC 1.4.13, hoverable), so this one opts back in.
      disableHoverableContent={false}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          data-no-dnd
          className={cn(
            // A bounded control with its own plate, on the text's own x: the
            // negative margin cancels the padding the plate is drawn on.
            "relative -mx-1 flex min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 text-left text-xs cursor-pointer transition-colors hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
            freshnessClass(freshnessLevel)
          )}
          aria-label={
            missingCredential
              ? // Which item, then the action: the badge still names what it's for
                // even though clicking it now opens Settings.
                `Issue ${issueLabel}${issueTitle ? `: ${issueTitle}` : ""}${worktreeSuffix}. Add a forge access token to see issue details`
              : `Open issue ${issueLabel}${issueTitle ? `: ${issueTitle}` : ""}${worktreeSuffix}`
          }
        >
          <CircleDot
            className={cn(
              "w-3 h-3 shrink-0",
              missingCredential ? "text-text-secondary" : "text-pr-open"
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              "truncate flex-1 min-w-0",
              missingCredential ? "text-text-secondary" : "text-text-primary"
            )}
          >
            {issueTitle ||
              (hideColdNumber ? null : (
                // The number in the line's own ink; the issue glyph beside it
                // carries the state in hue, as the PR line does.
                <span className="font-mono">{issueLabel}</span>
              ))}
          </span>
          {showPausedGlyph && (
            <CloudOff className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="p-3"
        {...HOVER_CARD_EVENT_FENCE}
        aria-label={
          data && !missingCredential
            ? describeIssueTooltip(data, freshness, {
                includeTitle: !issueTitle,
                issueKey: provenance?.issueKey,
              })
            : undefined
        }
      >
        {missingCredential ? (
          <TokenMissingTooltip type="issue" />
        ) : data ? (
          <IssueTooltipContent data={data} freshness={freshness} issueKey={provenance?.issueKey} />
        ) : (
          <TooltipFallback
            type="issue"
            number={issueNumber}
            reference={provenance?.issueKey}
            title={issueTitle}
            status={loading ? "loading" : error ? "failed" : "idle"}
            freshness={freshness}
          />
        )}
      </TooltipContent>
    </Tooltip>
  );
}

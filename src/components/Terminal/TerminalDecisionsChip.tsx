import { useEffect, useId, useState } from "react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Button } from "@/components/ui/button";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsOn } from "@/hooks/useDecisionsOn";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
  holdPaneSelection,
} from "./terminalHeaderChip";
import {
  POPOVER_HEADER_CLASS,
  POPOVER_HEADER_META_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { pluralize } from "@/lib/pluralize";
import type { PaneDecisionState } from "@shared/types/decisions";
import {
  chipLabel,
  chipSummary,
  decisionItems,
  deliveryNotes,
  itemSentence,
  needsAttention,
  type DecisionItem,
} from "./decisionsChipModel";

/**
 * One pane's Decisions state, as main last reported it — and only while
 * Decisions is on: off, nothing is subscribed and nothing is read.
 */
export function usePaneDecisionState(terminalId: string, on: boolean): PaneDecisionState | null {
  const [state, setState] = useState<PaneDecisionState | null>(null);

  useEffect(() => {
    if (!on) return;
    // An ambient chip must never take the pane header down with it: a bridge
    // that is missing or throws leaves the chip hidden.
    try {
      return decisionsClient.watchPaneState(terminalId, setState);
    } catch {
      return undefined;
    }
  }, [terminalId, on]);

  return on && state?.terminalId === terminalId ? state : null;
}

const ATTENTION_KINDS = new Set<DecisionItem["kind"]>(["attention", "uncertain"]);

function DecisionRow({ item }: { item: DecisionItem }) {
  const attention = ATTENTION_KINDS.has(item.kind);
  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <span className="w-9 shrink-0 font-mono text-xs leading-5 text-text-primary tabular-nums">
        {item.label}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The glyph marks the status's first line, however many it wraps to. */}
        <span className="flex items-start gap-1 text-xs leading-5 text-text-primary [text-wrap:pretty]">
          {attention && (
            <TriangleAlert
              className="mt-1 size-3 shrink-0 text-status-warning"
              aria-hidden="true"
            />
          )}
          {item.status}
        </span>
        {item.reason !== null && (
          <span className="text-2xs text-text-secondary [text-wrap:balance]">{item.reason}</span>
        )}
      </div>
      {item.askedAt !== null && (
        <TimeAgo
          timestamp={item.askedAt}
          prefix="asked "
          className="shrink-0 text-3xs leading-5 text-text-secondary"
        />
      )}
    </li>
  );
}

/**
 * Visible on a pane whose agent asked a question through Daintree Decisions,
 * while the question is out, its answer is waiting to be typed in, or the
 * answer needs a person. Self-gating: with Decisions off it renders nothing
 * and watches nothing.
 */
export function TerminalDecisionsChip({ terminalId }: { terminalId: string }) {
  const on = useDecisionsOn();
  const state = usePaneDecisionState(terminalId, on);
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const openAttention = useDecisionsAttentionStore((s) => s.open);

  if (state === null) return null;
  const items = decisionItems(state);
  if (items.length === 0) return null;

  const attention = needsAttention(items);
  const summary = chipSummary(items);
  const label = chipLabel(items);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Selecting the pane would close the popover this opens. */}
      <span className="contents" onClick={holdPaneSelection}>
        {/* Several questions make a sentence too long to read in the usual
            2.5 s, so this one stays while hovered or focused. */}
        <Tooltip autoDismiss={false} disableHoverableContent={false}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  HEADER_CHIP_CLASS,
                  HEADER_CHIP_SURFACE,
                  HEADER_CHIP_TRIGGER_CLASS,
                  HEADER_CHIP_FOCUS_CLASS,
                  "hover:text-text-primary"
                )}
                aria-label={summary}
                data-testid="terminal-decisions-chip"
              >
                {/* The mark says whose chip this is in every state; the warning
                    glyph follows the alias or count, so a count never reads as
                    that many warnings, and comes before the delivering detail,
                    so it never reads as belonging to the answer being typed in.
                    Shape as well as hue, for forced colours. */}
                <DecisionsIcon className="w-3 h-3 shrink-0" size={12} />
                <span className="tabular-nums">{label.text}</span>
                {attention && (
                  <TriangleAlert
                    className="w-3 h-3 shrink-0 text-status-warning"
                    aria-hidden="true"
                  />
                )}
                {/* A narrow header keeps the count and the warning; the
                    breakdown is in the tooltip and the popover. */}
                {label.detail !== null && (
                  <span className="tabular-nums @max-[480px]/header:hidden">{label.detail}</span>
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {items.length === 1 ? itemSentence(items[0]!) : summary}
          </TooltipContent>
        </Tooltip>
      </span>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-96 p-0"
        aria-labelledby={headingId}
        data-testid="terminal-decisions-popover"
        // A click here must not select the pane underneath.
        onClick={(event) => event.preventDefault()}
      >
        <div className={POPOVER_HEADER_CLASS}>
          <span id={headingId} className={POPOVER_TITLE_CLASS}>
            Decisions
          </span>
          <span className={POPOVER_HEADER_META_CLASS}>{pluralize(items.length, "question")}</span>
        </div>
        <ul className="flex flex-col divide-y divide-divider">
          {items.map((item) => (
            <DecisionRow key={item.questionId} item={item} />
          ))}
        </ul>
        <div className="flex flex-col gap-0.5 border-t border-divider px-3 py-2 text-2xs text-text-secondary">
          {deliveryNotes(items).map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
        {/* The list reads this computer's answers; a Remote Host keeps its own panes'. */}
        {attention && !isRemoteWindow() && (
          <div className="flex justify-end border-t border-divider px-3 py-2">
            {/* The answers that need a person are acted on in the list, which
                also holds those whose pane is gone. */}
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setOpen(false);
                openAttention(terminalId);
              }}
              data-testid="terminal-decisions-review"
            >
              Review answers
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

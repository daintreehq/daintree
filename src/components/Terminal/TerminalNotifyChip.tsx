import { useCallback, useEffect, useId, useState } from "react";
import { Radar } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FOOTER_ITEM_CLASS } from "@/components/HelpPanel/footerItem";
import { terminalClient } from "@/clients";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
} from "./terminalHeaderChip";
import { POPOVER_HEADER_CLASS, POPOVER_TITLE_CLASS } from "@/components/ui/popoverHeader";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PaneNotifyState, TerminalNotifyDelivery } from "@shared/types/terminalNotify";

/**
 * One pane's pending terminal notices, as main last reported them.
 *
 * Subscribes before fetching, and keeps whichever carries the higher revision,
 * so a snapshot that lands after a push can never roll it back. Not a store:
 * nothing outside the pane reads it, and main holds the truth — a remount or a
 * rebuilt project view just asks again.
 */
export function usePaneNotifyState(terminalId: string): PaneNotifyState | null {
  const [state, setState] = useState<PaneNotifyState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const accept = (next: PaneNotifyState | null) => {
      if (cancelled) return;
      setState((current) => {
        if (next === null) return current?.terminalId === terminalId ? current : null;
        if (current?.terminalId === terminalId && current.revision > next.revision) return current;
        return next;
      });
    };
    // An ambient chip must never take the pane header down with it. A bridge
    // that is missing or throws leaves the chip hidden, which is also the
    // honest thing to show: nothing here can be acted on.
    let off: (() => void) | undefined;
    try {
      off = terminalClient.onNotifyState((payload) => {
        if (payload.terminalId === terminalId) accept(payload);
      });
      window.electron.mcpServer
        .getPaneNotifyState(terminalId)
        .then(accept)
        .catch(() => {});
    } catch {
      // Hidden, as above.
    }
    return () => {
      cancelled = true;
      off?.();
    };
  }, [terminalId]);

  return state?.terminalId === terminalId ? state : null;
}

type Tone = "quiet" | "warning";

function describeDelivery(delivery: TerminalNotifyDelivery): { text: string; tone: Tone } {
  switch (delivery.status) {
    case "idle":
      return { text: "Nothing to deliver yet.", tone: "quiet" };
    case "scheduled":
      return { text: "A terminal finished. The notice is on its way.", tone: "quiet" };
    case "held":
      if (delivery.reason === "typing") {
        return {
          text: "Held: something was typed into this pane's prompt since it settled. It goes out after the next turn.",
          tone: "quiet",
        };
      }
      if (delivery.reason === "interval") {
        return { text: "Held briefly to keep notices spaced out.", tone: "quiet" };
      }
      return { text: "Held until this pane finishes its turn.", tone: "quiet" };
    case "blocked":
      if (delivery.reason === "approval") {
        return { text: "Not sent: this pane is waiting on an approval.", tone: "warning" };
      }
      if (delivery.reason === "question") {
        return {
          text: "Not sent: this pane is waiting on an answer to a question.",
          tone: "warning",
        };
      }
      if (delivery.reason === "error") {
        return { text: "Not sent: this pane stopped on an error.", tone: "warning" };
      }
      return { text: "Not sent: no agent is waiting at this pane's prompt.", tone: "warning" };
    case "outstanding":
      return { text: "Delivered.", tone: "quiet" };
    case "failed":
      return {
        text: "The last notice couldn't be confirmed, so it goes out again after this pane's next turn.",
        tone: "warning",
      };
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Visible on a pane whose agent asked to be told when other terminals stop
 * working: Daintree may type one line into this pane's prompt. Self-gating,
 * and the only control over it the user needs — stopping drops every notice
 * the pane has pending.
 *
 * Two looks for two hosts. In a pane header it is one of the header's chips.
 * In the assistant's status footer it is a flat status item like its
 * neighbours, and says what it counts until the row runs out of room.
 */
export function TerminalNotifyChip({
  terminalId,
  variant = "header",
  compact = false,
}: {
  terminalId: string;
  variant?: "header" | "footer";
  /** Footer only: drop the noun and keep the count. */
  compact?: boolean;
}) {
  const state = usePaneNotifyState(terminalId);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const headingId = useId();

  const stop = useCallback(() => {
    setStopping(true);
    setStopFailed(false);
    window.electron.mcpServer
      .stopPaneNotices(terminalId)
      .catch((err: unknown) => {
        setStopFailed(true);
        logWarn("Failed to stop pane notices", { error: formatErrorMessage(err, "") });
      })
      .finally(() => setStopping(false));
  }, [terminalId]);

  if (state === null || (state.pendingCount === 0 && state.readyCount === 0)) return null;

  const { text, tone } = describeDelivery(state.delivery);
  const pending = state.pendingCount;
  const count = pending > 0 ? pending : state.readyCount;
  const counted = pending > 0 ? plural(pending, "terminal") : plural(state.readyCount, "notice");
  const heading = pending > 0 ? `Waiting on ${counted}` : `${counted} waiting to be delivered`;
  const footer = variant === "footer";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                footer
                  ? cn(FOOTER_ITEM_CLASS, "shrink-0 gap-1")
                  : cn(
                      HEADER_CHIP_CLASS,
                      HEADER_CHIP_SURFACE,
                      HEADER_CHIP_TRIGGER_CLASS,
                      HEADER_CHIP_FOCUS_CLASS
                    ),
                tone === "warning"
                  ? "text-status-warning"
                  : footer
                    ? "hover:text-text-primary aria-expanded:bg-overlay-soft"
                    : "text-text-secondary hover:text-text-primary"
              )}
              aria-label={`${heading}; Daintree may type a notice into this pane`}
              data-testid="terminal-notify-chip"
            >
              <Radar className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="tabular-nums">{footer && !compact ? counted : count}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={footer ? "top" : "bottom"}>
          {heading}. Daintree may type a notice into this pane.
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side={footer ? "top" : "bottom"}
        align="end"
        className="w-72 p-0"
        aria-labelledby={headingId}
      >
        <div className={POPOVER_HEADER_CLASS}>
          <span id={headingId} className={POPOVER_TITLE_CLASS}>
            {heading}
          </span>
        </div>
        <div className="flex flex-col gap-2 p-3">
          <p className="text-xs text-text-secondary">
            The agent asked to be told when other terminals stop working. Daintree types one line
            into this pane's prompt while it sits idle.
          </p>
          <p
            className={cn(
              "text-xs",
              tone === "warning" ? "text-status-warning" : "text-text-secondary"
            )}
            role="status"
          >
            {text}
          </p>
          {stopFailed && (
            <p className="text-xs text-status-danger" role="alert">
              Couldn't stop notices. They're still on.
            </p>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" size="xs" onClick={stop} disabled={stopping}>
              {stopFailed ? "Try again" : "Stop notices"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

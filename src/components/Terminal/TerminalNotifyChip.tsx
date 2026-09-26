import { useCallback, useEffect, useState } from "react";
import { Radar } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { terminalClient } from "@/clients";
import { cn } from "@/lib/utils";
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
      return { text: "Delivered. The agent is reading it.", tone: "quiet" };
    case "failed":
      return {
        text: "The last notice couldn't be confirmed, so it goes out again after this pane's next turn.",
        tone: "warning",
      };
  }
}

/**
 * Visible on a pane whose agent asked to be told when other terminals stop
 * working: Daintree may type one line into this pane's prompt. Self-gating,
 * and the only control over it the user needs — stopping drops every notice
 * the pane has pending.
 */
export function TerminalNotifyChip({ terminalId }: { terminalId: string }) {
  const state = usePaneNotifyState(terminalId);
  const [stopping, setStopping] = useState(false);

  const stop = useCallback(() => {
    setStopping(true);
    window.electron.mcpServer
      .stopPaneNotices(terminalId)
      .catch((err: unknown) => {
        logWarn("Failed to stop pane notices", { error: formatErrorMessage(err, "") });
      })
      .finally(() => setStopping(false));
  }, [terminalId]);

  if (state === null || (state.pendingCount === 0 && state.readyCount === 0)) return null;

  const { text, tone } = describeDelivery(state.delivery);
  const pending = state.pendingCount;
  const noun = pending === 1 ? "terminal" : "terminals";
  const heading =
    pending > 0 ? `Waiting on ${pending} ${noun}` : "A notice is waiting to be delivered";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 shrink-0 text-xs font-sans bg-overlay-soft px-1.5 py-0.5 rounded-full border border-divider hover:text-text-primary transition-colors",
            tone === "warning" ? "text-status-warning" : "text-text-secondary"
          )}
          aria-label={`${heading}; Daintree may type a notice into this pane`}
          data-testid="terminal-notify-chip"
        >
          <Radar className="w-3 h-3" aria-hidden="true" />
          <span className="tabular-nums">{pending > 0 ? pending : state.readyCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-primary">{heading}</span>
          <p className="text-xs text-text-secondary">
            The agent asked to be told when they stop working. Daintree types one line into this
            pane's prompt while it sits idle.
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
          <div className="flex justify-end">
            <Button variant="secondary" size="xs" onClick={stop} disabled={stopping}>
              Stop notices
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

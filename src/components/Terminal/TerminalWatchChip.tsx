import { useCallback, useEffect, useState } from "react";
import { Radar } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { terminalClient } from "@/clients";
import { cn } from "@/lib/utils";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PaneWatchState, TerminalWatchDelivery } from "@shared/types/terminalWatch";

/**
 * One pane's terminal-watch state (#12491), as main last reported it.
 *
 * Subscribes before fetching, and keeps whichever carries the higher revision,
 * so a snapshot that lands after a push can never roll it back. Not a store:
 * nothing outside the pane reads it, and main holds the truth — a remount or a
 * rebuilt project view just asks again.
 */
export function usePaneWatchState(terminalId: string): PaneWatchState | null {
  const [state, setState] = useState<PaneWatchState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const accept = (next: PaneWatchState | null) => {
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
      off = terminalClient.onWatchState((payload) => {
        if (payload.terminalId === terminalId) accept(payload);
      });
      window.electron.mcpServer
        .getPaneWatchState(terminalId)
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

function describeDelivery(delivery: TerminalWatchDelivery): { text: string; tone: Tone } {
  switch (delivery.status) {
    case "idle":
      return { text: "Nothing new since the last wake.", tone: "quiet" };
    case "scheduled":
      return { text: "Something changed. A wake is on its way.", tone: "quiet" };
    case "held":
      if (delivery.reason === "typing") {
        return {
          text: "Held: something was typed into this pane's prompt since it settled. It goes out after the next turn.",
          tone: "quiet",
        };
      }
      if (delivery.reason === "interval") {
        return { text: "Held briefly to keep wakes spaced out.", tone: "quiet" };
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
      return { text: "Woken. Waiting for the agent to read what changed.", tone: "quiet" };
    case "failed":
      return {
        text: "The last wake couldn't be confirmed, so no more are sent until the agent reads what changed.",
        tone: "warning",
      };
  }
}

/**
 * Visible on a pane whose agent holds terminal watches (#12491): Daintree may
 * type one line into this pane's prompt when the watched terminals change.
 * Self-gating, and the only control over it the user needs — stopping ends
 * every watch the pane holds.
 */
export function TerminalWatchChip({ terminalId }: { terminalId: string }) {
  const state = usePaneWatchState(terminalId);
  const [stopping, setStopping] = useState(false);

  const stop = useCallback(() => {
    setStopping(true);
    window.electron.mcpServer
      .stopPaneWatches(terminalId)
      .catch((err: unknown) => {
        logWarn("Failed to stop pane watches", { error: formatErrorMessage(err, "") });
      })
      .finally(() => setStopping(false));
  }, [terminalId]);

  if (state === null || state.watchCount === 0) return null;

  const { text, tone } = describeDelivery(state.delivery);
  const watched = state.watchedTerminalCount;
  const noun = watched === 1 ? "terminal" : "terminals";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 shrink-0 text-xs font-sans bg-overlay-soft px-1.5 py-0.5 rounded-full border border-divider hover:text-text-primary transition-colors",
            tone === "warning" ? "text-status-warning" : "text-text-secondary"
          )}
          aria-label={`Watching ${watched} ${noun}; this pane may be woken`}
          data-testid="terminal-watch-chip"
        >
          <Radar className="w-3 h-3" aria-hidden="true" />
          <span className="tabular-nums">{watched}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-primary">
            Watching {watched} {noun}
          </span>
          <p className="text-xs text-text-secondary">
            When they change, Daintree types one line into this pane's prompt while it sits idle,
            pointing the agent at what it saw.
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
              Stop watching
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

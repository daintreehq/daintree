import { MemoryStick } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HOST_MEMORY_PAUSE_COPY } from "@/lib/hostMemoryPauseCopy";
import { actionService } from "@/services/ActionService";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";

/**
 * The terminal-host memory pause, shown once for the whole app (#12375). The
 * governor pauses every terminal on a host at once, so this stands in for what
 * used to be an identical pill on every affected pane.
 *
 * Tier-1 ambient, no accent. The icon's presence says an episode is open; the
 * warning pip says output is held right now, so a lifted pause reads as the
 * same icon without its pip rather than an identical twin. Fixed chrome
 * rather than a registry button — it only exists while an episode does, so
 * there is nothing to pin, hide, or overflow.
 */
export function HostMemoryPauseIndicator() {
  const visible = useHostMemoryPauseStore((s) => s.visible);
  const paused = useHostMemoryPauseStore((s) => s.snapshot?.paused ?? false);

  if (!visible) return null;

  const copy = paused ? HOST_MEMORY_PAUSE_COPY.paused : HOST_MEMORY_PAUSE_COPY.monitoring;

  return (
    // The body is the explanation, not a hint, so it stays while hovered or
    // focused rather than timing out mid-read.
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-toolbar-item=""
          data-testid="host-memory-pause-indicator"
          onClick={() =>
            void actionService.dispatch("diagnostics.openWhySlow", undefined, { source: "user" })
          }
          className="toolbar-icon-button relative text-text-primary"
          aria-label={copy.ariaLabel}
        >
          {/* Anchored to the glyph with the shared pip geometry, like the
              notification and agent pips beside it. */}
          <span className="relative inline-flex">
            <MemoryStick aria-hidden="true" />
            <span
              aria-hidden="true"
              data-testid="host-memory-pause-pip"
              data-visible={paused}
              className="toolbar-pip toolbar-badge bg-status-warning"
            />
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{copy.title}</span>
          <span>{copy.body}</span>
          <span className="mt-0.5 text-text-secondary">{HOST_MEMORY_PAUSE_COPY.detailsHint}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

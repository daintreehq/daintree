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
 * Tier-1 ambient: a neutral icon carrying the toolbar's warning pip, no accent.
 * Fixed chrome rather than a registry button — it only exists while a pause
 * does, so there is nothing to pin, hide, or overflow.
 */
export function HostMemoryPauseIndicator() {
  const visible = useHostMemoryPauseStore((s) => s.visible);
  const paused = useHostMemoryPauseStore((s) => s.snapshot?.paused ?? false);

  if (!visible) return null;

  const copy = paused ? HOST_MEMORY_PAUSE_COPY.paused : HOST_MEMORY_PAUSE_COPY.monitoring;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-toolbar-item=""
          data-testid="host-memory-pause-indicator"
          onClick={() =>
            void actionService.dispatch("diagnostics.openWhySlow", undefined, { source: "user" })
          }
          className="toolbar-icon-button relative text-text-secondary"
          aria-label={copy.ariaLabel}
        >
          <MemoryStick aria-hidden="true" />
          <span
            aria-hidden="true"
            data-visible="true"
            className="toolbar-badge absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-status-warning ring-1 ring-surface-sidebar"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{copy.title}</span>
          <span>{copy.body}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

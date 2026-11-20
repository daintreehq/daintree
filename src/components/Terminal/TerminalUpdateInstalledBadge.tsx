import { CircleArrowUp } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { formatTimeAgo } from "@/utils/timeAgo";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
} from "./terminalHeaderChip";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import type { UpdateInstalledObservation } from "@shared/types/ipc/agent";

/**
 * Ambient header chip on a pane whose Claude Code showed its "Update
 * installed" footer (#17905): what the pane drew and when, never a version.
 * It stays while that run lives and goes with it.
 */
export function TerminalUpdateInstalledBadge({ terminalId }: { terminalId: string }) {
  const observation = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.updateInstalled : undefined;
  });
  return observation ? <UpdateInstalledChip observation={observation} /> : null;
}

// Split out so only a pane that has an observation subscribes to the clock.
function UpdateInstalledChip({ observation }: { observation: UpdateInstalledObservation }) {
  const now = useGlobalMinuteClock();
  return (
    <Tooltip autoDismiss={false} disableHoverableContent={false}>
      <TooltipTrigger asChild>
        <div
          className={cn(HEADER_CHIP_CLASS, HEADER_CHIP_SURFACE, HEADER_CHIP_FOCUS_CLASS)}
          role="status"
          aria-live="off"
          tabIndex={0}
          data-testid="terminal-update-installed-badge"
          data-fit-priority="40"
        >
          {/* A 16px line box around the glyph, so the chip keeps the row's
              height when a narrow header takes the label out of flow. */}
          <span className="inline-flex h-4 shrink-0 items-center">
            <CircleArrowUp className="w-3 h-3" aria-hidden="true" />
          </span>
          {/* Reported, as the rate-limit chip says: the footer's own words
              stay in the tooltip, with when the pane showed them. */}
          <span className="@max-[420px]/header:sr-only">Update reported</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            Claude Code showed “Update installed” {formatTimeAgo(observation.observedAt, now)}
          </span>
          {observation.namesRestart && <span>The footer named /restart</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

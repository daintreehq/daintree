import type { MouseEvent } from "react";
import { CalendarClock } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import {
  readScheduleName,
  retryScheduleNames,
  scheduleNameLabel,
  useScheduleNames,
  type ScheduleNameReading,
} from "@/store/scheduleNamesStore";
import { isPtyPanel } from "@shared/types/panel";
import { readSpawnProvenance } from "@shared/utils/scheduledRunProvenance";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
} from "./terminalHeaderChip";

/** The schedule a pane was launched for, read as a pair with its source (#15977). */
function useTerminalScheduleId(terminalId: string): string | null {
  return usePanelStore((state) => {
    const panel = state.panelsById[terminalId];
    if (!panel || !isPtyPanel(panel)) return null;
    return (
      readSpawnProvenance(panel.spawnedBy, panel.scheduledRun).scheduledRun?.scheduleId ?? null
    );
  });
}

function describe(reading: ScheduleNameReading): string {
  switch (reading.kind) {
    case "named":
      return `Scheduled run of ${reading.name}`;
    case "deleted":
      return "Scheduled run of a deleted schedule";
    case "unnamed":
    case "remote":
      return "Scheduled run";
  }
}

/**
 * Which schedule launched this pane (#15987), beside its title. Activating it
 * opens the Schedules view at that schedule's runs. A window driving a Remote
 * Host can't show schedules, so there it's a plain label. Renders nothing, and
 * reads nothing, for a pane no schedule launched.
 */
export function TerminalScheduleChip({ terminalId }: { terminalId: string }) {
  const scheduleId = useTerminalScheduleId(terminalId);
  const { status, names } = useScheduleNames(scheduleId !== null);
  if (scheduleId === null) return null;

  const reading = readScheduleName(scheduleId, status, names);
  const description = describe(reading);
  const canOpen = reading.kind !== "remote";

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Never reaches the header (focus, drag, double-click maximise).
    event.stopPropagation();
    if (!canOpen) return;
    if (reading.kind === "unnamed") retryScheduleNames();
    void actionService.dispatch("schedules.open", { scheduleId }, { source: "user" });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-no-dnd
          data-testid="terminal-schedule-chip"
          aria-label={canOpen ? `${description}. Show the schedule's runs` : description}
          onClick={handleClick}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            HEADER_CHIP_CLASS,
            HEADER_CHIP_SURFACE,
            HEADER_CHIP_FOCUS_CLASS,
            "min-w-0 max-w-[12rem] shrink-[2] select-none",
            canOpen
              ? cn(HEADER_CHIP_TRIGGER_CLASS, "cursor-pointer hover:text-text-primary")
              : "cursor-default"
          )}
        >
          <CalendarClock className="h-3 w-3 shrink-0" aria-hidden="true" />
          {/* A narrow header keeps the mark and drops the name; the tooltip and
              the accessible name still carry it. */}
          <span className="min-w-0 truncate @max-[420px]/header:hidden">
            {scheduleNameLabel(reading)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-1">
          <span>{description}</span>
          <span className="text-text-secondary">
            {canOpen
              ? "Click to see the schedule's runs"
              : "Schedules are for projects on this machine"}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

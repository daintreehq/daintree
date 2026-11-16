import { History } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useResumedSessionPanelStore } from "@/store/resumedSessionPanelStore";
import { HEADER_CHIP_CLASS, HEADER_CHIP_SURFACE } from "./terminalHeaderChip";

const DESCRIPTION = "Resumed session: a new process carrying on the closed panel's conversation";

/**
 * Marks a pane Cmd+Z brought back after the trash had let its agent go
 * (#17107): the conversation is the one that was closed, the process and its
 * scrollback are not. Renders nothing for any other pane.
 */
export function TerminalResumedChip({ terminalId }: { terminalId: string }) {
  const resumed = useResumedSessionPanelStore((state) => state.panelIds.has(terminalId));
  if (!resumed) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={DESCRIPTION}
          data-testid="terminal-resumed-chip"
          className={cn(HEADER_CHIP_CLASS, HEADER_CHIP_SURFACE, "cursor-default select-none")}
        >
          <History className="h-3 w-3 shrink-0" aria-hidden="true" />
          {/* A narrow header keeps the mark; the tooltip and name carry the rest. */}
          <span className="@max-[420px]/header:hidden">Resumed</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{DESCRIPTION}</TooltipContent>
    </Tooltip>
  );
}

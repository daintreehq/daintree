import { FlagTriangleRight } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTerminalWhenDoneStore } from "@/store/terminalWhenDoneStore";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
} from "./terminalHeaderChip";

const WHEN_DONE_COPY = {
  background: {
    label: "When done: background",
    detail: "Moves to the background when the agent reports it's done.",
  },
  close: {
    label: "When done: close",
    detail: "Closes when the agent reports it's done. Its session stays resumable.",
  },
} as const;

/**
 * Ambient header chip on an agent terminal armed with a When done choice
 * (#16171), naming what it will do. Shown only while main holds the choice.
 */
export function TerminalWhenDoneBadge({ terminalId }: { terminalId: string }) {
  const choice = useTerminalWhenDoneStore((s) => s.choices[terminalId]);
  if (choice === undefined) return null;
  const copy = WHEN_DONE_COPY[choice];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            HEADER_CHIP_CLASS,
            HEADER_CHIP_SURFACE,
            HEADER_CHIP_FOCUS_CLASS,
            "min-w-0 max-w-[12rem] shrink"
          )}
          role="status"
          aria-live="off"
          tabIndex={0}
          data-testid="terminal-when-done-badge"
          data-when-done={choice}
        >
          <FlagTriangleRight className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{copy.label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="flex min-w-0 flex-col gap-0.5 break-words">
          <span className="font-medium">{copy.label}</span>
          <span>{copy.detail} Not while you're using it.</span>
          <span className="mt-0.5 text-text-secondary">Terminal menu → When done</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

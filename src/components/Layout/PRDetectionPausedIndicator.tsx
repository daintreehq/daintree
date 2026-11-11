import type { ReactNode } from "react";
import { CloudOff } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

const PAUSED_LABEL = "PR detection paused — retrying";

interface PRDetectionPausedIndicatorProps {
  defaultOpen?: boolean;
  /**
   * False while another trailing slot already stands for the fault (the
   * data-unavailable warning, the rate-limit clock) and names the pause in its
   * own tooltip. The announcement below still runs.
   */
  showSlot?: boolean;
  contextMenuContent?: ReactNode;
  onContextMenuOpenChange?: (open: boolean) => void;
}

export function PRDetectionPausedIndicator({
  defaultOpen = false,
  showSlot = true,
  contextMenuContent,
  onContextMenuOpenChange,
}: PRDetectionPausedIndicatorProps) {
  const tripped = usePRCircuitBreakerStore((s) => s.tripped);

  // A live region only announces changes to content it already holds, so it
  // stays mounted and empty until the pause begins.
  const announcement = (
    <span role="status" aria-live="polite" className="sr-only">
      {tripped ? PAUSED_LABEL : ""}
    </span>
  );

  if (!tripped || !showSlot) return announcement;

  // A focusable toolbar item like the rate-limit clock, so keyboard focus
  // opens the same tooltip a pointer gets.
  const trigger = (
    <TooltipTrigger asChild>
      <button
        type="button"
        data-stat-segment=""
        data-toolbar-item=""
        aria-label={PAUSED_LABEL}
        className="toolbar-stat-status flex h-full w-7 shrink-0 cursor-default items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      >
        <CloudOff className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
      </button>
    </TooltipTrigger>
  );

  return (
    <>
      <Tooltip defaultOpen={defaultOpen}>
        {contextMenuContent ? (
          <ContextMenu onOpenChange={onContextMenuOpenChange}>
            <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
            <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              {contextMenuContent}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          trigger
        )}
        <TooltipContent side="bottom">{PAUSED_LABEL}</TooltipContent>
      </Tooltip>
      {/* After the slot, so the capsule's segments stay adjacent siblings. */}
      {announcement}
    </>
  );
}

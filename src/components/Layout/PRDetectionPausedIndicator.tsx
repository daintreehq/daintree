import type { ReactNode } from "react";
import { CloudOff } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

interface PRDetectionPausedIndicatorProps {
  defaultOpen?: boolean;
  contextMenuContent?: ReactNode;
  onContextMenuOpenChange?: (open: boolean) => void;
}

export function PRDetectionPausedIndicator({
  defaultOpen = false,
  contextMenuContent,
  onContextMenuOpenChange,
}: PRDetectionPausedIndicatorProps) {
  const tripped = usePRCircuitBreakerStore((s) => s.tripped);

  if (!tripped) return null;

  const trigger = (
    <TooltipTrigger asChild>
      <div
        role="status"
        aria-live="polite"
        aria-label="PR detection paused — retrying"
        className="flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground"
      >
        <CloudOff className="h-3.5 w-3.5 text-text-muted" aria-hidden />
      </div>
    </TooltipTrigger>
  );

  return (
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
      <TooltipContent side="bottom" className="px-3 py-1.5">
        <span className="text-xs text-text-secondary">PR detection paused — retrying</span>
      </TooltipContent>
    </Tooltip>
  );
}

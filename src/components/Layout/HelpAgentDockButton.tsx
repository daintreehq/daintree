import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
import { useHelpPanelStore } from "@/store/helpPanelStore";

interface HelpAgentDockButtonProps {
  compact?: boolean;
}

export function HelpAgentDockButton({ compact = false }: HelpAgentDockButtonProps) {
  const isOpen = useHelpPanelStore((s) => s.isOpen);
  const toggle = useHelpPanelStore((s) => s.toggle);

  const handleClick = useCallback(() => {
    toggle();
  }, [toggle]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="pill"
            size="sm"
            className={cn(
              compact ? "px-1.5 min-w-0" : "px-2.5",
              isOpen && "bg-canopy-border border-canopy-accent/40 ring-1 ring-canopy-accent/30"
            )}
            onClick={handleClick}
            aria-label="Help Agent"
            aria-expanded={isOpen}
          >
            <CanopyIcon className="w-3.5 h-3.5 text-canopy-text/50" />
            {!compact && <span className="font-medium">Help</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {isOpen ? "Close help panel" : "Open help panel"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

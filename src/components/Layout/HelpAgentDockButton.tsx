import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { useHelpPanelStore } from "@/store/helpPanelStore";

export function HelpAgentDockButton() {
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
              "px-2",
              isOpen &&
                "bg-daintree-border border-daintree-accent/40 ring-1 ring-daintree-accent/30"
            )}
            onClick={handleClick}
            aria-label="Help Agent"
            aria-expanded={isOpen}
          >
            <DaintreeIcon className="w-3.5 h-3.5 text-daintree-text/50" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {isOpen ? "Close help panel" : "Open help panel"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

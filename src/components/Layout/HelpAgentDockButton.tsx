import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";

export function HelpAgentDockButton() {
  const isOpen = useHelpPanelStore((s) => s.isOpen);
  const toggle = useHelpPanelStore((s) => s.toggle);

  const handleClick = useCallback(() => {
    suppressSidebarResizes();
    toggle();
  }, [toggle]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pill"
          size="sm"
          className={cn("px-2", isOpen && "bg-overlay-emphasis border-border-default")}
          onClick={handleClick}
          aria-label="Daintree Assistant"
          aria-expanded={isOpen}
        >
          <DaintreeIcon className="w-3.5 h-3.5 text-daintree-text/50" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isOpen ? "Close Daintree Assistant" : "Open Daintree Assistant"}
      </TooltipContent>
    </Tooltip>
  );
}

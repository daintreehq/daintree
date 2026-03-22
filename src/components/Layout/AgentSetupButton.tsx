import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sprout } from "lucide-react";

export function AgentSetupButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-toolbar-item={dataToolbarItem}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"));
            }}
            className="toolbar-agent-button text-canopy-text hover:text-[var(--recipe-toolbar-control-hover-fg)] focus-visible:text-[var(--recipe-toolbar-control-hover-fg)] transition-colors"
            aria-label="Install AI Agents"
          >
            <Sprout className="text-canopy-accent" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Install AI Agents</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

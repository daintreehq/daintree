import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PackagePlus } from "lucide-react";

export function AgentSetupButton() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"));
            }}
            className="text-canopy-text hover:bg-white/[0.06] hover:text-canopy-accent focus-visible:text-canopy-accent transition-colors"
            aria-label="Install AI Agents"
          >
            <PackagePlus className="text-canopy-accent" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Install AI Agents</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

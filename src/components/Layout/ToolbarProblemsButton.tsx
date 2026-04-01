import { memo } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay } from "@/hooks";

const toolbarIconButtonClass = "toolbar-icon-button text-canopy-text transition-colors";

interface ToolbarProblemsButtonProps {
  errorCount: number;
  onToggleProblems?: () => void;
  "data-toolbar-item"?: string;
}

export const ToolbarProblemsButton = memo(function ToolbarProblemsButton({
  errorCount,
  onToggleProblems,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarProblemsButtonProps) {
  const diagnosticsShortcut = useKeybindingDisplay("panel.toggleDiagnostics");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-toolbar-item={dataToolbarItem}
            onClick={onToggleProblems}
            className={cn(
              toolbarIconButtonClass,
              "relative",
              errorCount > 0 && "text-status-error"
            )}
            aria-label={`Problems: ${errorCount} error${errorCount !== 1 ? "s" : ""}`}
          >
            <AlertCircle />
            {errorCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-status-error rounded-full" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {createTooltipWithShortcut("Show Problems Panel", diagnosticsShortcut)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

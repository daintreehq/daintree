import { SquareDashedMousePointer } from "lucide-react";
import type { DevPreviewToolButtonProps } from "@/services/devPreviewTools/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The dev preview toolbar toggle; every dev preview has it. */
export function ElementPickerButton({ active, onToggle }: DevPreviewToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Element Picker"
          aria-pressed={active}
          className={cn(
            "toolbar-icon-button rounded-[var(--radius-md)] p-1.5",
            active && "bg-overlay-soft text-text-primary"
          )}
        >
          <SquareDashedMousePointer className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {active ? "Close Element Picker" : "Pick an element and ask an agent to change it"}
      </TooltipContent>
    </Tooltip>
  );
}

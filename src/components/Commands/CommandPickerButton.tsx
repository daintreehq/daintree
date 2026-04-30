import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { createTooltipWithShortcut } from "@/lib/platform";
import { SquareTerminal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface CommandPickerButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export const CommandPickerButton = forwardRef<HTMLButtonElement, CommandPickerButtonProps>(
  ({ onClick, disabled = false, className }, ref) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
              "flex items-center justify-center",
              "h-6 w-6 rounded-[var(--radius-sm)]",
              "text-daintree-text/50 hover:text-daintree-text/80 hover:bg-tint/[0.06]",
              "transition-colors",
              "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent",
              disabled && "opacity-50 cursor-not-allowed",
              className
            )}
            aria-label="Open command picker"
          >
            <SquareTerminal className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {createTooltipWithShortcut("Open command picker", "Cmd+K")}
        </TooltipContent>
      </Tooltip>
    );
  }
);

CommandPickerButton.displayName = "CommandPickerButton";

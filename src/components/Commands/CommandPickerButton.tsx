import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Terminal } from "lucide-react";

interface CommandPickerButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export const CommandPickerButton = forwardRef<HTMLButtonElement, CommandPickerButtonProps>(
  ({ onClick, disabled = false, className }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex items-center justify-center",
          "h-7 w-7 rounded-[var(--radius-sm)]",
          "text-canopy-text/50 hover:text-canopy-text/80 hover:bg-white/[0.06]",
          "transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent",
          disabled && "opacity-50 cursor-not-allowed",
          className
        )}
        title="Open command picker (⌘K)"
        aria-label="Open command picker"
      >
        <Terminal className="h-4 w-4" />
      </button>
    );
  }
);

CommandPickerButton.displayName = "CommandPickerButton";

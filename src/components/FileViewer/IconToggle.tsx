import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Square pressed-state toggle used by the diff surfaces' footer controls.
 * Extracted from `FileViewerModal` when the diff viewer moved into the panel
 * model so the pane could keep the same affordance.
 */
export function IconToggle({
  pressed,
  label,
  onToggle,
  children,
}: {
  pressed: boolean;
  label: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={pressed}
          aria-label={label}
          className={cn(
            "p-1.5 rounded transition-colors",
            pressed
              ? "bg-border-default text-text-primary"
              : "text-muted-foreground hover:text-text-primary hover:bg-border-default"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

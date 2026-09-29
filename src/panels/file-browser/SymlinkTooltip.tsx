import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Where a symlinked row points, for the pointer. The row itself is the focus
 * target and already carries the same words as screen-reader text, so this
 * adds no tab stop of its own.
 */
export function SymlinkTooltip({
  description,
  children,
}: {
  description: string | null | undefined;
  children: ReactElement;
}) {
  if (!description) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="break-words">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface DismissButtonProps extends Omit<
  ButtonProps,
  "variant" | "size" | "children" | "asChild" | "loading" | "type" | "title"
> {
  /** Names what goes away ("Dismiss editing tip"), not just "Dismiss". */
  "aria-label": string;
  /** Tooltip text. Defaults to "Dismiss"; the accessible name carries the object. */
  tooltip?: React.ReactNode;
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
}

/**
 * The X that dismisses a card, banner, hint, notification or finished row: a
 * ghost `icon-xs` button (24px target) with a 14px glyph — the same box and
 * glyph as the panel-chrome actions it usually sits beside.
 *
 * Placement (`absolute top-2 right-2`, `-my-1`) stays with the caller. Size,
 * shape, hover, focus, press and disabled do not; they are the Button
 * primitive's, which is the point.
 */
export const DismissButton = React.forwardRef<HTMLButtonElement, DismissButtonProps>(
  ({ className, tooltip = "Dismiss", tooltipSide = "bottom", ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0 [&_svg]:size-3.5", className)}
          {...props}
        >
          <X aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
    </Tooltip>
  )
);
DismissButton.displayName = "DismissButton";

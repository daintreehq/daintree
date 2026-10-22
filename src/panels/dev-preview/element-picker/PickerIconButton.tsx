import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PickerIconButtonProps extends Omit<
  ButtonProps,
  "children" | "variant" | "size" | "asChild" | "aria-label"
> {
  icon: ReactNode;
  "aria-label": string;
}

/** A ghost icon button whose tooltip is its accessible name. */
export function PickerIconButton({ icon, "aria-label": label, ...props }: PickerIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} variant="ghost" size="icon-xs" aria-label={label}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

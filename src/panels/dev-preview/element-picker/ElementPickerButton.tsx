import { SquareDashedMousePointer } from "lucide-react";
import type { DevPreviewToolButtonProps } from "@/services/devPreviewTools/types";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TOOL_NAME } from "./toolId.js";

/**
 * The dev preview toolbar toggle; every dev preview has it. Its name is the
 * tool's and holds still — whether it is on travels on `aria-pressed` and the
 * toolbar's shared armed treatment, as every other toggle in the row does.
 */
export function ElementPickerButton({ active, onToggle }: DevPreviewToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={TOOL_NAME}
          aria-pressed={active}
          className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
        >
          <SquareDashedMousePointer className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{TOOL_NAME}</TooltipContent>
    </Tooltip>
  );
}

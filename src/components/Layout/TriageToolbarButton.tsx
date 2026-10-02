import { useCallback } from "react";
import { ScanEye } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { useTriageStore } from "@/store/triageStore";
import { actionService } from "@/services/ActionService";
import { preloadTriageView } from "@/lazyPanels";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";

const TRIAGE_ACTION_ID = "triage.toggle" as const;
const TRIAGE_LABEL = "Triage agents";
const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

export function TriageToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const isOpen = useTriageStore((s) => s.isOpen);
  const shortcut = useEffectiveCombo(TRIAGE_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(TRIAGE_ACTION_ID);
  const hover = useShortcutHintHover(TRIAGE_ACTION_ID);

  const handleClick = useCallback(() => {
    void actionService.dispatch(TRIAGE_ACTION_ID, undefined, { source: "user" });
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onPointerEnter={(event) => {
                  // Warm the panel's chunk on intent rather than at boot, so the
                  // first click doesn't flash a frame of nothing.
                  void preloadTriageView();
                  hover.onPointerEnter(event);
                }}
                onPointerLeave={hover.onPointerLeave}
                onPointerDown={hover.onPointerDown}
                onFocus={(event) => {
                  void preloadTriageView();
                  hover.onFocus(event);
                }}
                onBlur={hover.onBlur}
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                onClick={handleClick}
                className={toolbarIconButtonClass}
                aria-label={TRIAGE_LABEL}
                aria-keyshortcuts={ariaShortcut}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
              >
                <ScanEye />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent(TRIAGE_LABEL, shortcut)}
            </TooltipContent>
          </Tooltip>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="triage" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

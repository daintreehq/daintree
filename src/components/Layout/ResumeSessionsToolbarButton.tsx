import { useCallback, useRef, useState } from "react";
import { History } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { actionService } from "@/services/ActionService";
import { shortcutHintStore } from "@/store/shortcutHintStore";

const RESUME_ACTION_ID = "terminal.resumeSessions" as const;
const RESUME_LABEL = "Resume session";
const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";

interface ResumeSessionsToolbarButtonProps {
  "data-toolbar-item"?: string;
}

export function ResumeSessionsToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: ResumeSessionsToolbarButtonProps) {
  const shortcut = useKeybindingDisplay(RESUME_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(RESUME_ACTION_ID);
  const hover = useShortcutHintHover(RESUME_ACTION_ID);

  // The launcher opens via dispatch and AppPaletteDialog imperatively restores
  // focus to this button on close. Mirror ToolbarCommandPaletteButton: a
  // controlled tooltip gated on the focus restore so it doesn't re-fire.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);

  const handleTooltipOpenChange = useCallback((open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setTooltipOpen(open);
  }, []);

  const handlePointerEnter = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      isRestoringFocusRef.current = false;
      hover.onPointerEnter(e);
    },
    [hover]
  );

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLButtonElement>) => {
      if (isRestoringFocusRef.current) return;
      hover.onFocus(e);
    },
    [hover]
  );

  const handleClick = useCallback(() => {
    isRestoringFocusRef.current = true;
    setTooltipOpen(false);
    shortcutHintStore.getState().hide();
    void actionService.dispatch(RESUME_ACTION_ID, undefined, { source: "user" }).finally(() => {
      shortcutHintStore.getState().hide();
    });
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
          <TooltipTrigger asChild>
            <Button
              onPointerEnter={handlePointerEnter}
              onPointerLeave={hover.onPointerLeave}
              onPointerDown={hover.onPointerDown}
              onFocus={handleFocus}
              onBlur={hover.onBlur}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={handleClick}
              className={toolbarIconButtonClass}
              aria-label={RESUME_LABEL}
              aria-keyshortcuts={ariaShortcut}
            >
              <History />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(RESUME_LABEL, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="resume-sessions" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

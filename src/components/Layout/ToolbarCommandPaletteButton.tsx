import { useCallback, useRef, useState } from "react";
import { SquareMenu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { actionService } from "@/services/ActionService";
import { shortcutHintStore } from "@/store/shortcutHintStore";

const PALETTE_ACTION_ID = "action.palette.open" as const;
const PALETTE_LABEL = "Command palette";
const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";

interface ToolbarCommandPaletteButtonProps {
  "data-toolbar-item"?: string;
}

export function ToolbarCommandPaletteButton({
  "data-toolbar-item": dataToolbarItem,
}: ToolbarCommandPaletteButtonProps) {
  const shortcut = useKeybindingDisplay(PALETTE_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(PALETTE_ACTION_ID);
  const hover = useShortcutHintHover(PALETTE_ACTION_ID);

  // The action palette opens via dispatch and AppPaletteDialog imperatively
  // restores focus to this button on close (see AppPaletteDialog.tsx:55-68).
  // Without suppression the focus restore re-fires the Radix tooltip AND the
  // shortcut hint's focus handler. Mirror the AgentButton / DockLaunchButton
  // pattern: controlled tooltip, ref-gated open, cleared on the next genuine
  // pointer hover.
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
    // Set suppression BEFORE dispatch so the focus restore that follows the
    // palette's close (which targets this button via AppPaletteDialog's
    // previousFocusRef) is rejected by handleTooltipOpenChange. Also tear
    // down any in-flight tooltip / shortcut hint from hover dwell so they
    // don't briefly reappear during the palette's enter animation.
    isRestoringFocusRef.current = true;
    setTooltipOpen(false);
    shortcutHintStore.getState().hide();
    // ActionService.emitShortcutHint fires after the action's run() and
    // re-shows the shortcut hint at the recorded pointer (i.e. on top of
    // the just-opened palette, because ShortcutHint sits at z-toast above
    // z-modal). The user already saw the shortcut in this button's
    // tooltip, so the post-dispatch hint is redundant — clear it once the
    // dispatch chain settles.
    void actionService.dispatch(PALETTE_ACTION_ID, undefined, { source: "user" }).finally(() => {
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
              aria-label={PALETTE_LABEL}
              aria-keyshortcuts={ariaShortcut}
            >
              <SquareMenu />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(PALETTE_LABEL, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="command-palette" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

import { useCallback, useEffect, useRef } from "react";
import { Menu } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const APP_MENU_LABEL = "Application menu";
const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

/**
 * In-app entry point to the native application menu on Windows and Linux
 * (#11813).
 *
 * Windows hides the native title bar for the Window Controls Overlay, which
 * removes the frame region the menu bar would render into — Alt reveals
 * nothing, so every menu-only action is unreachable. Linux keeps a real frame
 * (Alt works) but nothing advertises that the menu exists. Both get this
 * button; macOS keeps its system menu bar and renders nothing here.
 *
 * The click asks main to pop up the installed `Menu` object itself rather than
 * rendering a DOM replica, so the popup always matches the real menu — Open
 * Recent, installed agents, plugin contributions and the live update label
 * included — with no second source of truth to drift.
 */
export function AppMenuButton() {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Where the caret was before the user reached for the menu. The Edit menu's
  // items act on `webContents.getFocusedWebContents()`, which resolves against
  // whatever DOM node holds focus — so Cut/Copy/Paste/Select All only work if
  // focus is back on the user's editor when the popup opens.
  const externalFocusRef = useRef<HTMLElement | null>(null);

  // Tracked document-wide rather than from this button's own `relatedTarget`:
  // the toolbar implements roving focus, so arrowing across it calls .focus()
  // on each item in turn. `relatedTarget` would then be the neighbouring
  // toolbar button, and restoring THAT would still leave Edit commands aimed
  // at chrome. Ignoring everything inside the toolbar keeps the last genuine
  // editing target instead, however the user travelled here.
  useEffect(() => {
    if (isMac()) return;

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[role="toolbar"]')) return;
      externalFocusRef.current = target;
    };

    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  // Pointer activation: keep focus exactly where it is. `preventDefault` on
  // pointerdown suppresses the browser's focus-on-press, so the common case
  // never disturbs the caret at all and the restore below is a no-op.
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
  }, []);

  const handleClick = useCallback(() => {
    // Keyboard activation genuinely moved focus onto this button, so hand it
    // back before main reads the focused element.
    const restoreTo = externalFocusRef.current;
    if (restoreTo?.isConnected) {
      restoreTo.focus({ preventScroll: true });
    }

    // Anchor the popup under the button. Omitting the rect is survivable —
    // main falls back to Electron's cursor default — so this never blocks.
    const rect = buttonRef.current?.getBoundingClientRect();
    safeFireAndForget(
      window.electron.menu.showApplication(rect ? { x: rect.left, y: rect.bottom } : undefined),
      { context: "Failed to open the application menu" }
    );
  }, []);

  if (isMac()) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          variant="ghost"
          size="icon"
          data-toolbar-item=""
          data-app-menu-button=""
          onPointerDown={handlePointerDown}
          onClick={handleClick}
          className={toolbarIconButtonClass}
          aria-label={APP_MENU_LABEL}
          aria-haspopup="menu"
        >
          <Menu />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{APP_MENU_LABEL}</TooltipContent>
    </Tooltip>
  );
}

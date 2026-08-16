import { useCallback, useRef } from "react";
import { Menu } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const APP_MENU_LABEL = "Application menu";
const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";

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
  // The element focus should return to before the menu opens. The Edit menu's
  // items act on `webContents.getFocusedWebContents()`, which resolves against
  // whatever DOM node holds focus — letting this button take focus would point
  // Cut/Copy/Paste/Select All at the button instead of the user's input.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Pointer activation: keep focus where it already is. `preventDefault` on
  // pointerdown stops the browser's focus-on-press, so nothing to restore.
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    previousFocusRef.current = null;
    event.preventDefault();
  }, []);

  // Keyboard activation: focus genuinely moved here as the user tabbed in, so
  // capture where it came from and hand it back before the menu opens.
  const handleFocus = useCallback((event: React.FocusEvent<HTMLButtonElement>) => {
    const from = event.relatedTarget;
    previousFocusRef.current =
      from instanceof HTMLElement && from !== event.currentTarget ? from : null;
  }, []);

  const handleClick = useCallback(() => {
    const button = buttonRef.current;

    const restoreTo = previousFocusRef.current;
    previousFocusRef.current = null;
    if (restoreTo?.isConnected) {
      restoreTo.focus({ preventScroll: true });
    }

    // Anchor the popup under the button. Omitting the rect is survivable —
    // main falls back to Electron's cursor default — so this never blocks.
    const rect = button?.getBoundingClientRect();
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
          onFocus={handleFocus}
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

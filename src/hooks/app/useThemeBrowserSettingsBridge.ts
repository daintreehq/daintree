import { useEffect, useRef } from "react";
import { useThemeBrowserStore } from "@/store";

/**
 * Coordinates Settings <-> theme browser transitions.
 *
 * Closing Settings on browser open keeps the full app chrome visible for
 * live preview. If the browser was entered from Settings, closing it
 * dispatches `daintree:open-settings-tab` to return the user to the
 * Appearance section so the just-committed theme is reflected in the
 * picker hero. Opens from other entry points (command palette, keybinding)
 * do NOT pop Settings open on close — that would surprise the user with
 * a surface they didn't ask for.
 */
export function useThemeBrowserSettingsBridge(
  isSettingsOpen: boolean,
  setIsSettingsOpen: (open: boolean) => void
) {
  const isThemeBrowserOpen = useThemeBrowserStore((s) => s.isOpen);
  const prevIsOpenRef = useRef(false);
  const openedFromSettingsRef = useRef(false);

  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isThemeBrowserOpen;

    if (!wasOpen && isThemeBrowserOpen) {
      openedFromSettingsRef.current = isSettingsOpen;
      setIsSettingsOpen(false);
    } else if (wasOpen && !isThemeBrowserOpen) {
      if (openedFromSettingsRef.current) {
        window.dispatchEvent(
          new CustomEvent("daintree:open-settings-tab", {
            detail: { tab: "general", sectionId: "appearance-theme" },
          })
        );
      }
      openedFromSettingsRef.current = false;
    }
  }, [isThemeBrowserOpen, isSettingsOpen, setIsSettingsOpen]);
}

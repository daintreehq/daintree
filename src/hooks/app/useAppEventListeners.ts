import { useEffect, useRef } from "react";
import {
  useHelpPanelStore,
  usePaletteStore,
  usePluginManagerStore,
  useThemeBrowserStore,
} from "@/store";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";

interface AppEventListenerOptions {
  /**
   * Opens the new-terminal palette. Routed through the palette hook's `open()`
   * (not raw `openPalette`) so query/selection state is reset on open. The
   * palette has no production trigger of its own, so this event is its sole
   * programmatic entry point — used by E2E coverage, mirroring the theme and
   * log-level palette events above.
   */
  onOpenNewTerminalPalette?: () => void;
}

export function useAppEventListeners({ onOpenNewTerminalPalette }: AppEventListenerOptions = {}) {
  const openNewTerminalPaletteRef = useRef(onOpenNewTerminalPalette);
  useEffect(() => {
    openNewTerminalPaletteRef.current = onOpenNewTerminalPalette;
  }, [onOpenNewTerminalPalette]);

  useEffect(() => {
    const handleOpenThemePalette = () => {
      usePaletteStore.getState().openPalette("theme");
    };
    const handleOpenLogLevelPalette = () => {
      usePaletteStore.getState().openPalette("log-level");
    };
    const handleOpenNewTerminalPalette = () => {
      openNewTerminalPaletteRef.current?.();
    };
    const handleOpenThemeBrowser = () => {
      // The browser is the sole theme surface while open — close Help to avoid
      // stacking two right-edge panels, and open the browser itself. Settings
      // close/reopen is coordinated separately by a Settings-scoped effect
      // (see App.tsx) because `setIsSettingsOpen` lives in useSettingsDialog.
      if (useHelpPanelStore.getState().isOpen) {
        suppressSidebarResizes();
        useHelpPanelStore.getState().setOpen(false);
      }
      useThemeBrowserStore.getState().open();
    };
    const handleOpenPluginManager = () => {
      // The graduated plugin manager (#9558) is a first-class full-screen view.
      // Settings close (when opened from the Plugins tab) is coordinated by a
      // Settings-scoped effect in App.tsx, mirroring the theme browser, because
      // `setIsSettingsOpen` lives in useSettingsDialog rather than a store.
      usePluginManagerStore.getState().open();
    };

    window.addEventListener("daintree:open-theme-palette", handleOpenThemePalette);
    window.addEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
    window.addEventListener("daintree:open-new-terminal-palette", handleOpenNewTerminalPalette);
    window.addEventListener("daintree:open-theme-browser", handleOpenThemeBrowser);
    window.addEventListener("daintree:open-plugin-manager", handleOpenPluginManager);
    return () => {
      window.removeEventListener("daintree:open-theme-palette", handleOpenThemePalette);
      window.removeEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
      window.removeEventListener(
        "daintree:open-new-terminal-palette",
        handleOpenNewTerminalPalette
      );
      window.removeEventListener("daintree:open-theme-browser", handleOpenThemeBrowser);
      window.removeEventListener("daintree:open-plugin-manager", handleOpenPluginManager);
    };
  }, []);
}

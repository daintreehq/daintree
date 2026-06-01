import { useEffect } from "react";
import {
  useHelpPanelStore,
  usePaletteStore,
  usePluginManagerStore,
  useThemeBrowserStore,
} from "@/store";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";

export function useAppEventListeners() {
  useEffect(() => {
    const handleOpenThemePalette = () => {
      usePaletteStore.getState().openPalette("theme");
    };
    const handleOpenLogLevelPalette = () => {
      usePaletteStore.getState().openPalette("log-level");
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
    window.addEventListener("daintree:open-theme-browser", handleOpenThemeBrowser);
    window.addEventListener("daintree:open-plugin-manager", handleOpenPluginManager);
    return () => {
      window.removeEventListener("daintree:open-theme-palette", handleOpenThemePalette);
      window.removeEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
      window.removeEventListener("daintree:open-theme-browser", handleOpenThemeBrowser);
      window.removeEventListener("daintree:open-plugin-manager", handleOpenPluginManager);
    };
  }, []);
}

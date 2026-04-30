import { useEffect } from "react";
import { useHelpPanelStore, usePaletteStore, useThemeBrowserStore } from "@/store";

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
      useHelpPanelStore.getState().setOpen(false);
      useThemeBrowserStore.getState().open();
    };

    window.addEventListener("daintree:open-theme-palette", handleOpenThemePalette);
    window.addEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
    window.addEventListener("daintree:open-theme-browser", handleOpenThemeBrowser);
    return () => {
      window.removeEventListener("daintree:open-theme-palette", handleOpenThemePalette);
      window.removeEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
      window.removeEventListener("daintree:open-theme-browser", handleOpenThemeBrowser);
    };
  }, []);
}

import { useEffect } from "react";
import { usePaletteStore } from "@/store";

export function useAppEventListeners() {
  useEffect(() => {
    const handleOpenNotesPalette = () => {
      usePaletteStore.getState().openPalette("notes");
    };
    const handleOpenThemePalette = () => {
      usePaletteStore.getState().openPalette("theme");
    };
    const handleOpenLogLevelPalette = () => {
      usePaletteStore.getState().openPalette("log-level");
    };

    window.addEventListener("daintree:open-notes-palette", handleOpenNotesPalette);
    window.addEventListener("daintree:open-theme-palette", handleOpenThemePalette);
    window.addEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
    return () => {
      window.removeEventListener("daintree:open-notes-palette", handleOpenNotesPalette);
      window.removeEventListener("daintree:open-theme-palette", handleOpenThemePalette);
      window.removeEventListener("daintree:open-log-level-palette", handleOpenLogLevelPalette);
    };
  }, []);
}

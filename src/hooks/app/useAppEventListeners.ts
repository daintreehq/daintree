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

    window.addEventListener("daintree:open-notes-palette", handleOpenNotesPalette);
    window.addEventListener("daintree:open-theme-palette", handleOpenThemePalette);
    return () => {
      window.removeEventListener("daintree:open-notes-palette", handleOpenNotesPalette);
      window.removeEventListener("daintree:open-theme-palette", handleOpenThemePalette);
    };
  }, []);
}

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

    window.addEventListener("canopy:open-notes-palette", handleOpenNotesPalette);
    window.addEventListener("canopy:open-theme-palette", handleOpenThemePalette);
    return () => {
      window.removeEventListener("canopy:open-notes-palette", handleOpenNotesPalette);
      window.removeEventListener("canopy:open-theme-palette", handleOpenThemePalette);
    };
  }, []);
}

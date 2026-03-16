import { useEffect } from "react";
import { usePaletteStore } from "@/store";

export function useAppEventListeners() {
  useEffect(() => {
    const handleOpenNotesPalette = () => {
      usePaletteStore.getState().openPalette("notes");
    };

    window.addEventListener("canopy:open-notes-palette", handleOpenNotesPalette);
    return () => window.removeEventListener("canopy:open-notes-palette", handleOpenNotesPalette);
  }, []);
}

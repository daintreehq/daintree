import { useCallback } from "react";
import type React from "react";
import type { MenuItemOption } from "@shared/types";

export function useNativeContextMenu() {
  const showMenu = useCallback(
    async (event: React.MouseEvent, template: MenuItemOption[]): Promise<string | null> => {
      if (!window.electron?.menu?.showContext) return null;

      event.preventDefault();
      event.stopPropagation();

      try {
        const x = Math.round(event.screenX);
        const y = Math.round(event.screenY);
        return await window.electron.menu.showContext({ template, x, y });
      } catch (error) {
        console.error("Failed to show native context menu:", error);
        return null;
      }
    },
    []
  );

  return { showMenu };
}

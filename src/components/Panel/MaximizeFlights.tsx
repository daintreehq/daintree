import { useEffect } from "react";
import { usePanelStore } from "@/store/panelStore";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { isProjectViewObservable } from "@/lib/viewCacheState";
import { triggerPanelTransition } from "./PanelTransitionOverlay";

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/** The grid element standing for any of `ids`: a tab group renders as its active tab's pane. */
function findGridPane(ids: readonly string[]): Element | null {
  for (const id of ids) {
    const element = document.querySelector(
      `[data-panel-id="${cssEscape(id)}"][data-panel-location="grid"]`
    );
    if (!element) continue;
    const { width, height } = element.getBoundingClientRect();
    if (width > 0 && height > 0) return element;
  }
  return null;
}

/**
 * Flies the dock's ghost between a pane's grid cell and the maximized canvas.
 *
 * Maximize and restore swap the whole grid layout in one commit, so without a
 * flight the pane you were in jumps to fill the canvas and, on the way back,
 * lands in a cell you have to find again. Every route (header button,
 * double-click, keybinding, palette, plugin layouts) goes through the store, and
 * its listeners run before React re-renders, so the outgoing layout is still on
 * screen to measure. Maximize grows like a restore from the dock; restore
 * shrinks into the cell with the dock's landing hairline, which names the cell
 * the pane went back to. It flies a frame rather than the dock's card: the
 * pane never leaves the canvas, so nothing needs standing in for it.
 *
 * Renders nothing. Mounted once beside `PanelTransitionOverlay`.
 */
export function MaximizeFlights(): null {
  useEffect(
    () =>
      usePanelStore.subscribe((state, prev) => {
        const growing = prev.maximizedId === null && state.maximizedId !== null;
        const shrinking = prev.maximizedId !== null && state.maximizedId === null;
        if (!growing && !shrinking) return;
        // Automation can maximize in a project view nobody is looking at.
        if (prefersReducedMotion() || !isProjectViewObservable()) return;

        const panelId = (growing ? state.maximizedId : prev.maximizedId) as string;
        const panel = prev.panelsById[panelId] ?? state.panelsById[panelId];
        if (!panel) return;
        const group = prev.getPanelGroup?.(panelId);
        const ids = group ? [panelId, ...group.panelIds.filter((id) => id !== panelId)] : [panelId];

        const source = findGridPane(ids)?.getBoundingClientRect();
        if (!source) return;

        triggerPanelTransition(
          panelId,
          growing ? "restore" : "minimize",
          { x: source.x, y: source.y, width: source.width, height: source.height },
          () => {
            // Reversed before it landed: let the newer flight have the screen.
            const isMaximized = usePanelStore.getState().maximizedId === panelId;
            return isMaximized === growing ? findGridPane(ids) : null;
          },
          panel.title,
          `maximize:${group ? `group:${group.id}` : panelId}`,
          "frame"
        );
      }),
    []
  );
  return null;
}

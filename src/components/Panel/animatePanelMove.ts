import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import {
  triggerPanelTransition,
  type TransitionDirection,
  type TransitionRect,
} from "./PanelTransitionOverlay";

type Placement = "grid" | "dock";

const FROM: Record<TransitionDirection, Placement> = { minimize: "grid", restore: "dock" };
const TO: Record<TransitionDirection, Placement> = { minimize: "dock", restore: "grid" };

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/**
 * The on-screen box standing for any of `ids` in `placement`. A tab group shows
 * up as one element keyed by a single member — the active tab's pane in the
 * grid, the first member's chip in the dock — so every member is tried.
 */
function findBox(ids: readonly string[], placement: Placement): TransitionRect | null {
  for (const id of ids) {
    const selector =
      placement === "grid"
        ? `[data-panel-id="${cssEscape(id)}"][data-panel-location="grid"]`
        : `[data-dock-item-id="${cssEscape(id)}"]`;
    const element = document.querySelector(selector);
    if (!element) continue;
    const { x, y, width, height } = element.getBoundingClientRect();
    if (width > 0 && height > 0) return { x, y, width, height };
  }
  return null;
}

/**
 * Move a pane between the grid and the dock, and fly a ghost from where it was to
 * where it went. `move` runs exactly once whatever happens, and is never delayed
 * for the animation.
 *
 * The ghost only flies for a move that actually happened: the source is measured
 * before `move`, and the destination is measured afterwards and only once the store
 * places the pane there. A refused move (a non-dockable kind, an overlay pane) or a
 * no-op produces no motion. `move` returning `false` is taken at its word. With no
 * panel store registered (an isolated test, a harness) it is a plain `move()`.
 */
export function animatePanelMove(
  panelId: string,
  direction: TransitionDirection,
  move: () => unknown
): void {
  if (prefersReducedMotion()) {
    move();
    return;
  }

  const before = getPanelStoreSnapshot();
  const panel = before?.panelsById[panelId];
  const from = FROM[direction];
  const to = TO[direction];
  if (!panel || panel.location !== from) {
    move();
    return;
  }

  let ids = [panelId];
  for (const group of before.tabGroups.values()) {
    if (group.panelIds.includes(panelId)) {
      ids = [panelId, ...group.panelIds.filter((id) => id !== panelId)];
      break;
    }
  }
  const source = findBox(ids, from);

  if (move() === false || !source) return;

  triggerPanelTransition(
    panelId,
    direction,
    source,
    () => (getPanelStoreSnapshot()?.panelsById[panelId]?.location === to ? findBox(ids, to) : null),
    panel.title
  );
}

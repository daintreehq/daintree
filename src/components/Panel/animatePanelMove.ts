import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import { isProjectViewObservable } from "@/lib/viewCacheState";
import { triggerPanelTransition, type TransitionDirection } from "./PanelTransitionOverlay";

type Placement = "grid" | "dock";

const FROM: Record<TransitionDirection, Placement> = { minimize: "grid", restore: "dock" };
const TO: Record<TransitionDirection, Placement> = { minimize: "dock", restore: "grid" };

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

/**
 * The on-screen element standing for any of `ids` in `placement`. A tab group
 * shows up as one element keyed by a single member — the active tab's pane in
 * the grid, the first member's chip in the dock — so every member is tried. In
 * the dock it is the chip itself, not the full-height slot it sits in.
 */
function findElement(ids: readonly string[], placement: Placement): Element | null {
  for (const id of ids) {
    const selector =
      placement === "grid"
        ? `[data-panel-id="${cssEscape(id)}"][data-panel-location="grid"]`
        : `[data-dock-item-id="${cssEscape(id)}"]`;
    const slot = document.querySelector(selector);
    // A dock slot is taller than the chip drawn in it; land on the chip itself.
    const element = placement === "dock" ? (slot?.querySelector("[data-dock-item]") ?? slot) : slot;
    if (!element) continue;
    const { width, height } = element.getBoundingClientRect();
    if (width > 0 && height > 0) return element;
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
  // Automation can move panes in a project view nobody is looking at (cached, or
  // a hidden window); decorating those is work with no audience.
  if (prefersReducedMotion() || !isProjectViewObservable()) {
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
  let identity = panelId;
  for (const [groupId, group] of before.tabGroups) {
    if (group.panelIds.includes(panelId)) {
      ids = [panelId, ...group.panelIds.filter((id) => id !== panelId)];
      // The group moves as one, whichever member asked, so a flight started
      // through one member is superseded by a reversal through another.
      identity = `group:${groupId}`;
      break;
    }
  }
  const sourceElement = findElement(ids, from);
  const source = sourceElement?.getBoundingClientRect();

  if (move() === false || !source) return;

  triggerPanelTransition(
    panelId,
    direction,
    { x: source.x, y: source.y, width: source.width, height: source.height },
    () =>
      getPanelStoreSnapshot()?.panelsById[panelId]?.location === to ? findElement(ids, to) : null,
    panel.title,
    identity
  );
}

import type { ComponentType } from "react";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import type { ToolbarButtonIconProps, ToolbarButtonMetadata } from "./toolbarButtonMetadata";

export type ToolbarSide = "left" | "right";

export interface ToolbarVisibilityMenuRow {
  id: AnyToolbarButtonId;
  side: ToolbarSide;
  label: string;
  icon: ComponentType<ToolbarButtonIconProps>;
  checked: boolean;
}

export interface ToolbarVisibilityMenuRows {
  left: ToolbarVisibilityMenuRow[];
  right: ToolbarVisibilityMenuRow[];
}

export interface ToolbarVisibilityMenuRowSource {
  resolveMetadata: (id: AnyToolbarButtonId) => ToolbarButtonMetadata | undefined;
  /** Whether this view could draw the button at all if it were switched on. */
  canRender: (id: AnyToolbarButtonId) => boolean;
  isOnToolbar: (id: AnyToolbarButtonId) => boolean;
}

/**
 * Rows for the toolbar's empty-space menu (#12355), one per button that holds a
 * toolbar slot, in the order the toolbar draws them.
 *
 * Takes the side lists *before* the visibility filter. Hiding a button never
 * removes its position, so those lists are exactly the set a hidden button can
 * be brought back from — which is the whole job of this menu.
 *
 * A row is dropped when the view has nothing to draw for it (Problems without
 * developer tools, an empty plugin tray) or no name to show it by, because a
 * checkbox that changes nothing on screen is worse than no checkbox. An id
 * sitting on both sides keeps its first row only.
 */
export function buildToolbarVisibilityMenuRows(
  leftButtons: readonly AnyToolbarButtonId[],
  rightButtons: readonly AnyToolbarButtonId[],
  source: ToolbarVisibilityMenuRowSource
): ToolbarVisibilityMenuRows {
  const seen = new Set<AnyToolbarButtonId>();
  const toRows = (ids: readonly AnyToolbarButtonId[], side: ToolbarSide) => {
    const rows: ToolbarVisibilityMenuRow[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!source.canRender(id)) continue;
      const metadata = source.resolveMetadata(id);
      if (!metadata) continue;
      rows.push({
        id,
        side,
        label: metadata.label,
        icon: metadata.icon,
        checked: source.isOnToolbar(id),
      });
    }
    return rows;
  };
  return { left: toRows(leftButtons, "left"), right: toRows(rightButtons, "right") };
}

/**
 * Built-in metadata first, then the live plugin and launcher-item entries.
 *
 * Own-property reads, not bracket reads: the ids come from persisted arrays and
 * live registries, and a plain object literal would hand back an inherited
 * `Object.prototype` member for a key that happened to match one.
 */
export function resolveToolbarButtonMetadata(
  id: AnyToolbarButtonId,
  builtIn: Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>,
  dynamic: Readonly<Record<string, ToolbarButtonMetadata>>
): ToolbarButtonMetadata | undefined {
  if (Object.hasOwn(builtIn, id)) return builtIn[id];
  if (Object.hasOwn(dynamic, id)) return dynamic[id];
  return undefined;
}

// Every control region on the toolbar claims a no-drag rect, so "not inside one
// of these" is the same pixel set as the drag region — the empty space.
const TOOLBAR_CONTROL_SELECTOR = ".app-no-drag, [data-toolbar-button-id], [data-toolbar-item]";

/**
 * Whether a right-click landed on the toolbar's own empty space rather than on
 * a control or inside something the toolbar portals out.
 *
 * The containment check is load-bearing, not defensive. React bubbles a
 * `contextmenu` from portaled content up the component tree, and the toolbar
 * owns plenty of that — the launcher palette, overflow menus, the plugin tray,
 * notification history — none of which is a DOM descendant of `root`.
 */
export function isToolbarEmptySpaceTarget(target: EventTarget | null, root: Element): boolean {
  if (!(target instanceof Element) || !root.contains(target)) return false;
  const control = target.closest(TOOLBAR_CONTROL_SELECTOR);
  return control === null || !root.contains(control);
}

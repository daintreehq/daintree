import type { ComponentType } from "react";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { isAgentInstalled } from "../../../shared/utils/agentAvailability";
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
  /** Whether the button belongs in the menu at all — see `canListToolbarButton`. */
  canList: (id: AnyToolbarButtonId) => boolean;
  isOnToolbar: (id: AnyToolbarButtonId) => boolean;
}

/**
 * Rows for the toolbar's empty-space menu (#12355), one per listable button
 * holding a toolbar slot, in the order the toolbar draws them.
 *
 * Takes the side lists *before* the visibility filter. Hiding a built-in, a
 * fixed panel button or an agent keeps its position, so those lists are what a
 * hidden button is brought back from. Launcher items and tray-promoted plugin
 * buttons are the exception: unchecking one hands it back to the launcher or
 * the plugin tray that owns it, and it leaves the list along with its slot.
 *
 * An id sitting on both sides keeps its first row only.
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
      if (!source.canList(id)) continue;
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
 * Whether a button holding a toolbar slot belongs in the empty-space menu.
 *
 * It needs a renderer this view keeps. A built-in whose registry entry is off
 * here — Problems without developer tools, disabled notifications, an empty
 * plugin tray — would be a checkbox that changes nothing, so it drops out. A
 * project-scoped button stays even while its slot holds a placeholder, because
 * the preference is real: hiding Repository stats in a scratch workspace still
 * holds once a repository opens.
 *
 * Agents can't be gated on `isAvailable`, which for an agent *is* its
 * visibility and would drop exactly the hidden rows this menu exists to offer
 * back. One is listed once the user has pinned or hidden it, or its CLI is
 * installed. A profile that predates #11680 carries every agent id in its side
 * arrays, and offering to pin a CLI that isn't there is noise, not recovery.
 */
export function canListToolbarButton(
  id: AnyToolbarButtonId,
  registry: Readonly<Record<string, { isAvailable: boolean }>>,
  projectScopedIds: ReadonlySet<AnyToolbarButtonId>,
  agentSettings: AgentSettings | null | undefined,
  agentAvailability: CliAvailability | null | undefined
): boolean {
  if (!Object.hasOwn(registry, id)) return false;
  if (isBuiltInAgentId(id)) {
    return (
      agentSettings?.agents?.[id]?.pinned !== undefined || isAgentInstalled(agentAvailability?.[id])
    );
  }
  return registry[id]?.isAvailable === true || projectScopedIds.has(id);
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

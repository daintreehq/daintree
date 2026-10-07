import { PANEL_MENU_LABEL_MAX, PANEL_RUNTIME_MENU_MAX_ITEMS } from "../types/plugin.js";

/** The authored form the manifest's `menu` holds `actionId` to, `"{manifestId}.{id}"`. */
const AUTHORED_ACTION_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

/** A published menu entry after the host vetted it, its `actionId` in the instance's namespace. */
export interface PublishedPanelMenuItem {
  readonly actionId: string;
  readonly label?: string;
}

export type PanelMenuItemsResult =
  | { ok: true; items: readonly PublishedPanelMenuItem[] }
  | { ok: false; error: string };

/** A refused value, named without anything that can throw on plugin-supplied data. */
function describe(value: unknown): string {
  return typeof value === "string" ? `"${value.slice(0, 200)}"` : `of type ${typeof value}`;
}

function readField(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * Vet a runtime menu list a plugin published (#13213). The list arrives as
 * plugin code wrote it, so it is checked whole: one bad entry refuses the list
 * rather than dropping a row the author expects to see. Each `actionId` must
 * be in the plugin's own authored namespace, as the manifest's `menu` is, and
 * is rewritten into the instance's namespace — the same rewrite the manifest's
 * own entries get, so a project plugin dispatches its own action rather than a
 * same-named installed plugin's. `null` and `[]` both clear.
 */
export function normalizePanelMenuItems(
  items: unknown,
  manifestId: string,
  instanceId: string
): PanelMenuItemsResult {
  if (items === null || items === undefined) return { ok: true, items: [] };
  if (!Array.isArray(items)) return { ok: false, error: "items must be an array or null" };
  if (items.length > PANEL_RUNTIME_MENU_MAX_ITEMS) {
    return {
      ok: false,
      error: `at most ${PANEL_RUNTIME_MENU_MAX_ITEMS} entries, got ${items.length}`,
    };
  }
  const ownPrefix = `${manifestId}.`;
  const seen = new Set<string>();
  const vetted: PublishedPanelMenuItem[] = [];
  for (const [index, item] of items.entries()) {
    if (item === null || typeof item !== "object") {
      return { ok: false, error: `entry ${index} must be an object` };
    }
    const actionId = readField(item, "actionId");
    if (
      typeof actionId !== "string" ||
      !actionId.startsWith(ownPrefix) ||
      actionId.length === ownPrefix.length ||
      !AUTHORED_ACTION_ID.test(actionId)
    ) {
      return {
        ok: false,
        error: `entry ${index} actionId ${describe(actionId)} must be one of this plugin's own actions, written "${manifestId}.<id>"`,
      };
    }
    if (seen.has(actionId)) {
      return { ok: false, error: `entry ${index} repeats action "${actionId}"` };
    }
    seen.add(actionId);
    const rawLabel = readField(item, "label");
    if (rawLabel !== undefined && typeof rawLabel !== "string") {
      return { ok: false, error: `entry ${index} label must be a string` };
    }
    const label = rawLabel?.trim().slice(0, PANEL_MENU_LABEL_MAX);
    vetted.push({
      actionId: `${instanceId}.${actionId.slice(ownPrefix.length)}`,
      ...(label ? { label } : {}),
    });
  }
  return { ok: true, items: vetted };
}

/** Whether two vetted lists would draw the same menu. */
export function samePanelMenuItems(
  a: readonly PublishedPanelMenuItem[],
  b: readonly PublishedPanelMenuItem[]
): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => item.actionId === b[i]!.actionId && item.label === b[i]!.label)
  );
}

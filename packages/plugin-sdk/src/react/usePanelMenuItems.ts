import { useEffect, useRef } from "react";
import type {
  PanelMenuItemContribution,
  PanelViewProps,
} from "../../../../shared/types/plugin.js";

type MenuSetter = NonNullable<PanelViewProps["setMenuItems"]>;

function sameItems(
  a: readonly PanelMenuItemContribution[] | null,
  b: readonly PanelMenuItemContribution[] | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((item, i) => item.actionId === b[i]!.actionId && item.label === b[i]!.label);
}

/**
 * Keep your panel's contextual menu entries in step with the view: the
 * declarative side of `PanelViewProps.setMenuItems`.
 *
 * Publishes `items` when the view mounts and again whenever they change,
 * compared entry by entry so a fresh array literal on every render costs
 * nothing. Unmounting leaves the list alone: it belongs to the panel, so it
 * survives a tab switch or a move to the dock, and the host clears it when the
 * panel closes or the view reloads. Does nothing where the host offers no
 * setter (a project surface, a settings view, a panel shown as a dialog), and
 * returns `false` there.
 *
 * ```tsx
 * export default function LedgerView(props: PanelViewProps) {
 *   const selected = useSelectedRow();
 *   usePanelMenuItems(
 *     props,
 *     selected
 *       ? [
 *           { actionId: "acme.ledger.open-row", label: `Open ${selected.name}` },
 *           { actionId: "acme.ledger.delete-row" },
 *         ]
 *       : []
 *   );
 *   // …
 * }
 * ```
 *
 * @param view The view's props, or any object carrying its `setMenuItems`.
 * @param items The entries, each an `actionId` as the manifest would write it; `null` or `[]` offers none.
 * @returns `false` where the surface has no panel menus.
 */
export function usePanelMenuItems(
  view: Pick<PanelViewProps, "setMenuItems">,
  items: readonly PanelMenuItemContribution[] | null
): boolean {
  const setter = view.setMenuItems;
  const sentRef = useRef<{
    setter: MenuSetter;
    items: readonly PanelMenuItemContribution[] | null;
  } | null>(null);

  useEffect(() => {
    if (!setter) return;
    const sent = sentRef.current;
    if (sent !== null && sent.setter === setter && sameItems(sent.items, items)) return;
    sentRef.current = { setter, items };
    setter(items);
  }, [setter, items]);

  return setter !== undefined;
}

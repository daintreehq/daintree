import { useEffect, useRef } from "react";
import type {
  PanelViewProps,
  PluginPanelToolbarItemState,
} from "../../../../shared/types/plugin.js";
import { shallowEqual } from "./useHostStore.js";

type ToolbarSetter = NonNullable<PanelViewProps["setToolbarItemState"]>;

/**
 * Keep one of your panel's manifest `toolbar` buttons in step with the view:
 * the declarative side of `PanelViewProps.setToolbarItemState`.
 *
 * Sends `state` when the view mounts and again whenever it changes, compared
 * field by field so a fresh object literal on every render costs nothing.
 * Resets the button to rest (`null`) when the view unmounts or `actionId`
 * changes, so a button never keeps a spinner for a view that is gone. Does
 * nothing where the host offers no setter (a project surface), so it is safe
 * in a view that also renders there.
 *
 * ```tsx
 * export default function LedgerView(props: PanelViewProps) {
 *   const { refreshing, fetchedAt } = useQuotes();
 *   usePanelToolbarItem(props, "acme.ledger.refresh-quotes", {
 *     busy: refreshing,
 *     updatedAt: fetchedAt,
 *     staleAfterMs: 15 * 60_000,
 *   });
 *   // …
 * }
 * ```
 *
 * @param view The view's props, or any object carrying its `setToolbarItemState`.
 * @param actionId The button's `actionId` exactly as the manifest writes it.
 * @param state The button's live state; `null` leaves it at rest.
 */
export function usePanelToolbarItem(
  view: Pick<PanelViewProps, "setToolbarItemState">,
  actionId: string,
  state: PluginPanelToolbarItemState | null
): void {
  const setter = view.setToolbarItemState;
  const sentRef = useRef<{
    setter: ToolbarSetter;
    actionId: string;
    state: PluginPanelToolbarItemState | null;
  } | null>(null);

  useEffect(() => {
    if (!setter) return;
    const sent = sentRef.current;
    if (
      sent !== null &&
      sent.setter === setter &&
      sent.actionId === actionId &&
      shallowEqual(sent.state, state)
    ) {
      return;
    }
    sentRef.current = { setter, actionId, state };
    setter(actionId, state);
  }, [setter, actionId, state]);

  // React runs every cleanup before any setup, so a changed `actionId` resets
  // the old button before the sender above sets the new one.
  useEffect(() => {
    if (!setter) return;
    return () => {
      sentRef.current = null;
      setter(actionId, null);
    };
  }, [setter, actionId]);
}

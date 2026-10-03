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
 * When `actionId` changes, the old button is reset to rest (`null`) first.
 * Unmounting leaves the state alone: it belongs to the panel, so it survives
 * a tab switch or a move to the dock, and the host clears it when the panel
 * closes or the view reloads. Does nothing where the host offers no setter (a
 * project surface, a settings view, a panel shown as a dialog), so it is safe
 * in a view that also renders there, and returns `false` there so the view
 * can draw the control itself.
 *
 * ```tsx
 * export default function LedgerView(props: PanelViewProps) {
 *   const { fetchedAt } = useQuotes();
 *   // No `busy`: the host draws the button busy while the action runs.
 *   usePanelToolbarItem(props, "acme.ledger.refresh-quotes", {
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
 * @returns `false` where the surface has no panel header to draw the toolbar in.
 */
export function usePanelToolbarItem(
  view: Pick<PanelViewProps, "setToolbarItemState">,
  actionId: string,
  state: PluginPanelToolbarItemState | null
): boolean {
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
    // A setter from a reloaded attempt starts with nothing set, so only a
    // button this same setter was driving needs putting back to rest.
    if (sent !== null && sent.setter === setter && sent.actionId !== actionId) {
      setter(sent.actionId, null);
    }
    sentRef.current = { setter, actionId, state };
    setter(actionId, state);
  }, [setter, actionId, state]);

  return setter !== undefined;
}

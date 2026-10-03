import type { PanelViewProps } from "../../../../shared/types/plugin.js";

/**
 * Whether one of your actions is running right now, however it was dispatched:
 * the palette, a menu, the panel toolbar, a keybinding or an agent. The host
 * tracks the handler itself, so a refresh needs no "started" and "finished"
 * pushes of its own, and a view that mounts mid-run reads it at once. The
 * panel toolbar draws the action's button busy on its own while it runs.
 *
 * ```tsx
 * export default function LedgerView(props: PanelViewProps) {
 *   const refreshing = useActionRunning(props, "acme.ledger.refresh-quotes");
 *   return <Button loading={refreshing}>Refresh prices</Button>;
 * }
 * ```
 *
 * @param view The view's props, or any object carrying its `runningActions`.
 * @param actionId The action's id exactly as the manifest writes it.
 * @returns `false` on a host that does not track runs.
 */
export function useActionRunning(
  view: Pick<PanelViewProps, "runningActions">,
  actionId: string
): boolean {
  return view.runningActions?.includes(actionId) === true;
}

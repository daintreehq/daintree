import { tryFleetBroadcastFromEditor } from "@/components/Fleet/fleetEnterBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

/**
 * Enter in the focused, armed composer: hand the draft to the fleet. Whether
 * there is a fleet to send to is the broadcast's call, since it counts armed
 * agents on other hosts beside this view's own; a pane armed alone sends as
 * usual. True when the fleet took the draft; `onDelivered` runs only once the
 * broadcast has reached at least one target.
 */
export function tryComposerFleetBroadcast(
  isFocusedTerminal: boolean,
  terminalId: string,
  text: string,
  onDelivered: () => void
): boolean {
  if (!isFocusedTerminal || !useFleetArmingStore.getState().armedIds.has(terminalId)) return false;
  return tryFleetBroadcastFromEditor(terminalId, text, onDelivered);
}

import {
  tryFleetBroadcastFromEditor,
  type CrossHostRefusal,
} from "@/components/Fleet/fleetEnterBroadcast";

export {
  CROSS_HOST_CONTEXT_REFUSAL,
  CROSS_HOST_IMAGE_REFUSAL,
  type CrossHostRefusal,
} from "@/components/Fleet/fleetEnterBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

/**
 * Enter in the focused, armed composer: hand the draft to the fleet. Whether
 * there is a fleet to send to is the broadcast's call, since it counts armed
 * agents on other hosts beside this view's own; a pane armed alone sends as
 * usual. True when the fleet took the draft; `onDelivered` runs only once the
 * broadcast has reached at least one target, and `onRefused` when the draft
 * took nowhere because it would hand context or an image to another host's
 * agent. `imagePaths` are the draft's image chips, in order.
 */
export function tryComposerFleetBroadcast(
  isFocusedTerminal: boolean,
  terminalId: string,
  text: string,
  onDelivered: () => void,
  onRefused?: (reason: CrossHostRefusal) => void,
  imagePaths?: readonly string[]
): boolean {
  if (!isFocusedTerminal || !useFleetArmingStore.getState().armedIds.has(terminalId)) return false;
  return tryFleetBroadcastFromEditor(terminalId, text, onDelivered, onRefused, imagePaths);
}

import { hasHeldComposerSend, useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { composerSendHoldCause } from "@shared/utils/terminalWakeGate";
import type { PaneComposerHold } from "./submitComposerText";

/**
 * A pane's hold, read from the stores as the text goes: a choice dialog on
 * screen, or a turn in a CLI known to take down its input line, keeps it for
 * the pane's next prompt rather than lose it (#16379, #16872); main has the
 * last word. A working agent asks main too, since a dialog opened by its turn
 * may not have reached this view yet; main sends it at once if none did.
 */
export function paneComposerHold(id: string): PaneComposerHold {
  return {
    isHolding: () => hasHeldComposerSend(id),
    mayHold: () => {
      const panel = usePanelStore.getState().panelsById[id];
      if (!panel || !isPtyPanel(panel)) return false;
      if (panel.detectedAgentId !== undefined && panel.agentState === "working") return true;
      return (
        composerSendHoldCause({
          detectedAgentId: panel.detectedAgentId,
          agentState: panel.agentState,
          waitingReason: panel.waitingReason,
        }) !== null
      );
    },
    onHeld: (send) => useHeldComposerSendStore.getState().noteHeld(send),
    onRefused: () => useHeldComposerSendStore.getState().noteRefused(id),
  };
}

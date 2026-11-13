import { hasHeldComposerSend, useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isPtyPanel } from "@shared/types/panel";
import type { PaneComposerHold } from "./submitComposerText";

/**
 * A pane's hold, read from the stores as the text goes: mid-turn, a CLI not
 * declared to queue input keeps it for its next prompt rather than risk losing
 * it (#16379); main has the last word.
 */
export function paneComposerHold(id: string): PaneComposerHold {
  return {
    isHolding: () => hasHeldComposerSend(id),
    mayHold: () => {
      const panel = usePanelStore.getState().panelsById[id];
      if (!panel || !isPtyPanel(panel) || panel.agentState !== "working") return false;
      const agentId = panel.detectedAgentId;
      return (
        agentId !== undefined &&
        getEffectiveAgentConfig(agentId)?.capabilities?.queuesInputWhileWorking !== true
      );
    },
    onHeld: (send) => useHeldComposerSendStore.getState().noteHeld(send),
    onRefused: () => useHeldComposerSendStore.getState().noteRefused(id),
  };
}

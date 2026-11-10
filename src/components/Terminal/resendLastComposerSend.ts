import {
  getTerminalInputBlock,
  getTerminalInputBlockMessage,
  type TerminalInputBlock,
} from "@/services/terminal/inputGate";
import {
  peek as peekTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { hasHeldComposerSend, useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { getLastComposerSend } from "@/store/lastComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { paneComposerHold, submitPaneComposerText } from "./submitComposerText";

export const NOTHING_SENT_REASON = "Nothing has been sent to this panel yet";

/** What decides whether a pane's last message can go again, as it stands. */
export interface ResendReadiness {
  hasSend: boolean;
  /** A terminal panel, not restarting. */
  isLive: boolean;
  /** The panel's lock, or its instance's. */
  isInputLocked: boolean;
  inputBlock: TerminalInputBlock | null;
  isHolding: boolean;
}

/**
 * Why the last message can't go again, or undefined when it can. A working
 * agent that doesn't queue input is no reason: the resend is held for it, as
 * a typed send would be.
 */
export function resendUnavailableReason(readiness: ResendReadiness): string | undefined {
  if (!readiness.hasSend) return NOTHING_SENT_REASON;
  if (!readiness.isLive) return "This panel's terminal isn't running";
  if (readiness.isInputLocked) return "This panel's input is locked";
  if (readiness.inputBlock !== null) return getTerminalInputBlockMessage(readiness.inputBlock);
  if (readiness.isHolding) return "A message is already held for this panel";
  return undefined;
}

function isLiveTerminal(panel: PanelInstance | undefined): boolean {
  return panel !== undefined && isPtyPanel(panel) && panel.isRestarting !== true;
}

function isPaneInputLocked(id: string, panel: PanelInstance | undefined): boolean {
  if (panel !== undefined && isPtyPanel(panel) && panel.isInputLocked === true) return true;
  return peekTerminalService()?.get(id)?.isInputLocked === true;
}

export function readResendReadiness(terminalId: string): ResendReadiness {
  const panel = usePanelStore.getState().panelsById[terminalId];
  return {
    hasSend: getLastComposerSend(terminalId) !== undefined,
    isLive: isLiveTerminal(panel),
    isInputLocked: isPaneInputLocked(terminalId, panel),
    inputBlock: getTerminalInputBlock(),
    isHolding: hasHeldComposerSend(terminalId),
  };
}

/**
 * Sends a pane's last message again (#16746): the same text and images, by
 * the rules a typed send follows, held for a working agent that doesn't queue
 * input and refused while input is blocked or a message is already held. The
 * composer and its draft are never touched. Says whether it was taken.
 */
export function resendLastComposerSend(terminalId: string): Promise<boolean> {
  const last = getLastComposerSend(terminalId);
  if (last === undefined) return Promise.resolve(false);
  return submitPaneComposerText(terminalId, last.text, last.imagePaths, {
    canTakeInput: () => {
      const panel = usePanelStore.getState().panelsById[terminalId];
      return isLiveTerminal(panel) && !isPaneInputLocked(terminalId, panel);
    },
    onSending: () =>
      withTerminalService((service) => service.notifyUserInput(terminalId), terminalId),
    onAccepted: () => useHeldComposerSendStore.getState().clearDropped(terminalId),
    hold: paneComposerHold(terminalId),
  });
}

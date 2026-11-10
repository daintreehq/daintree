import { terminalClient } from "@/clients";
import { composerHoldClient } from "@/clients/composerHoldClient";
import { getTerminalInputBlock } from "@/services/terminal/inputGate";
import { hasHeldComposerSend, useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { claimComposerSendSeq, noteLastComposerSend } from "@/store/lastComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { logWarn } from "@/utils/logger";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { isImageAttachmentPath, MAX_SUBMIT_IMAGE_PATHS } from "@shared/utils/imageAttachmentInput";
import type { ComposerHoldResult, HeldComposerSend } from "@shared/types/ipc/composerHold";

/**
 * Submits a pane's composer text and says whether the terminal accepted it,
 * which is when a terminal-first user gets the keyboard back (#14692). submit
 * rejects when the PTY is gone (#8706), input is blocked, or main refuses an
 * attachment: the composer then keeps the draft and says it wasn't sent
 * (#14945), and the reason is logged here.
 */
export function submitComposerText(
  id: string,
  text: string,
  imagePaths: string[] | undefined,
  submissionToken?: string
): Promise<boolean> {
  let submission: Promise<void>;
  if (imagePaths !== undefined && imagePaths.length > 0) {
    submission =
      submissionToken === undefined
        ? terminalClient.submitWithImages(id, text, imagePaths)
        : terminalClient.submitWithImages(id, text, imagePaths, submissionToken);
  } else {
    submission =
      submissionToken === undefined
        ? terminalClient.submit(id, text)
        : terminalClient.submit(id, text, submissionToken);
  }
  return submission.then(
    () => true,
    (err: unknown) => {
      logWarn("[TerminalPane] submit failed", { id, error: err });
      return false;
    }
  );
}

/**
 * How a pane holds its composer's send while its agent works (#16379), read as
 * the text goes.
 */
export interface PaneComposerHold {
  /** The pane already holds a send: another is refused, never sent ahead of it. */
  isHolding: () => boolean;
  /** Its agent was last seen working, and isn't declared to queue input mid-turn. */
  mayHold: () => boolean;
  onHeld: (send: HeldComposerSend) => void;
  onRefused: () => void;
}

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

/** The images of a send that go as attachments, as `submitWithImages` picks them. */
export function attachableImagePaths(imagePaths: readonly string[] | undefined): string[] {
  return (imagePaths ?? []).filter(isImageAttachmentPath).slice(0, MAX_SUBMIT_IMAGE_PATHS);
}

/**
 * Asks main to hold the send. Null when input is blocked: it is never held,
 * and is refused the way it always was. A hold main couldn't take, or a
 * question it couldn't answer, isn't sent either: sending now into a busy
 * agent is what holding it was for.
 */
async function requestComposerHold(
  id: string,
  text: string,
  imagePaths: readonly string[] | undefined
): Promise<ComposerHoldResult | null> {
  if (getTerminalInputBlock()) return null;
  // As `submitWithImages` sends them: a path that can't be an attachment stays text.
  const attachable = attachableImagePaths(imagePaths);
  try {
    return await composerHoldClient.hold(id, text, attachable.length > 0 ? attachable : undefined);
  } catch (err) {
    logWarn("[TerminalPane] hold failed", { id, error: err });
    return { held: false, reason: "unavailable" };
  }
}

/**
 * A pane composer's `submitText`. Whether the pane can take input is read as
 * the text goes, not at the press: a `@diff` fetch awaited in between can
 * outlast a lock or a restart. Only a send the terminal took counts as the
 * user's input to it. A send held for the agent's next prompt counts as taken
 * by the composer, though nothing reached the terminal yet. Either way it is
 * the pane's last message (#16746), as it went, to send again.
 */
export async function submitPaneComposerText(
  id: string,
  text: string,
  imagePaths: readonly string[] | undefined,
  pane: {
    canTakeInput: () => boolean;
    onSending: () => void;
    onAccepted: () => void;
    hold?: PaneComposerHold;
  },
  submissionToken?: string
): Promise<boolean> {
  if (!pane.canTakeInput()) return false;
  const seq = claimComposerSendSeq();
  const { hold } = pane;
  if (hold !== undefined) {
    if (hold.isHolding()) {
      hold.onRefused();
      return false;
    }
    if (hold.mayHold()) {
      const answer = await requestComposerHold(id, text, imagePaths);
      if (answer?.held === true) {
        hold.onHeld(answer.send);
        noteLastComposerSend(id, answer.send.text, answer.send.imagePaths, seq);
        return true;
      }
      if (answer?.reason === "already-held") {
        hold.onRefused();
        return false;
      }
      if (answer?.reason === "unavailable") return false;
      if (!pane.canTakeInput()) return false;
    }
  }
  pane.onSending();
  const accepted = await submitComposerText(
    id,
    text,
    imagePaths && imagePaths.length > 0 ? [...imagePaths] : undefined,
    submissionToken
  );
  if (accepted) {
    noteLastComposerSend(id, text, attachableImagePaths(imagePaths), seq);
    pane.onAccepted();
  }
  return accepted;
}

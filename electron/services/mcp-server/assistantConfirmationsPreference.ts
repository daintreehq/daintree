// eager-import-allow: reads the assistant's confirmation settings via store.get on each call
import { store } from "../../store.js";
import {
  assistantPolicySkips,
  isHelpAssistantDaintreeConfirmations,
  resolveAssistantAgentSkip,
  resolveAssistantConfirmationPolicy,
  type AssistantConfirmationPolicy,
} from "../../../shared/utils/assistantDaintreeConfirmations.js";
import {
  DELEGABLE_ASSISTANT_CONFIRMATIONS,
  sanitizeDelegatedConfirmations,
} from "../../../shared/config/assistantConfirmationDelegation.js";
import { isStorableAssistantAgentId } from "../../../shared/types/ipc/agentDefaults.js";
import type { HelpAssistantDaintreeConfirmations } from "../../../shared/types/ipc/api.js";
import type { McpDelegationOffer } from "../../../shared/types/ipc/mcpServer.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:assistantConfirmations");

function asMode(value: unknown): HelpAssistantDaintreeConfirmations {
  return isHelpAssistantDaintreeConfirmations(value) ? value : "inherit";
}

function readMode(): HelpAssistantDaintreeConfirmations {
  return asMode(store.get("helpAssistant")?.daintreeConfirmations);
}

/**
 * Counts the writes the person makes to Daintree confirmations by hand, in
 * Settings or the dialog's own mode control, and never a hand-over from the
 * dialog (#16752). Each counts, even one that leaves the stored value as it
 * was: an untick of an action already gone is still a no to it. A tick
 * approved before one of them writes nothing: an approval reports back only
 * once its action has run, and a choice made by hand meanwhile is newer.
 */
let handEdits = 0;

/** Hears a write the person made to Daintree confirmations, after it lands. */
export function noteAssistantConfirmationsEdited(): void {
  handEdits += 1;
}

/**
 * This machine's assistant's Daintree confirmations (#12874), read live so
 * "Always ask", or an unticked action (#16752), takes effect on its next call.
 * The default follows the skip setting of the agent the session runs, else the
 * assistant's chosen agent (#14141).
 */
export function readAssistantConfirmationPolicy(
  sessionAgentId: string | null
): AssistantConfirmationPolicy {
  const helpAssistant = store.get("helpAssistant");
  const storedAgentId = helpAssistant?.agentId;
  const chosenAgentId = isStorableAssistantAgentId(storedAgentId) ? storedAgentId : null;
  return resolveAssistantConfirmationPolicy(
    helpAssistant?.daintreeConfirmations,
    helpAssistant?.daintreeConfirmationsExcept,
    resolveAssistantAgentSkip(sessionAgentId ?? chosenAgentId, store.get("agentSettings")).skips
  );
}

/** Whether this machine's assistant's call to `calledActionId` runs without asking. */
export function readAssistantConfirmationsSkipped(
  sessionAgentId: string | null,
  calledActionId: string
): boolean {
  return assistantPolicySkips(readAssistantConfirmationPolicy(sessionAgentId), calledActionId);
}

/**
 * "Don't ask again for this kind of action" for one dialog (#16752): what the
 * dialog shows, and the write an approval with the tick makes. Bound here to
 * the id the assistant called and to this machine's preference, so the view
 * that shows it can name neither.
 */
export interface PreparedAssistantDelegation {
  readonly offer: McpDelegationOffer;
  /**
   * The person approved the call the offer sits on: the setting as it stands
   * now is the one the tick applies to. A change they made by hand before
   * approving came before the tick; one made after it, while the call runs,
   * is newer and stands.
   */
  approved(): void;
  /**
   * Hands the action over, read again now: false, writing nothing, when the
   * person changed Daintree confirmations by hand since approving (since the
   * offer, if {@link approved} was never called), when the
   * mode now skips everything, so ticking the box can never start asking
   * about other actions, or when it has moved off the one the offer was
   * worded for to anything but "Ask, except for…".
   */
  commit(): boolean;
}

/**
 * The tick a dialog about this machine's assistant's call to `calledActionId`
 * may offer, or null: an action that can't be handed over, a mode that
 * already skips everything (switching to "Ask, except for…" would start
 * asking about every other action), one already handed over, or a
 * preference that can't be read.
 */
export function prepareAssistantDelegation(
  sessionAgentId: string | null,
  calledActionId: string
): PreparedAssistantDelegation | null {
  const entry = DELEGABLE_ASSISTANT_CONFIRMATIONS.find(
    (candidate) => candidate.id === calledActionId
  );
  if (entry === undefined) return null;
  let mode: HelpAssistantDaintreeConfirmations;
  let policy: AssistantConfirmationPolicy;
  try {
    mode = readMode();
    policy = readAssistantConfirmationPolicy(sessionAgentId);
  } catch (error) {
    logger.warn("Couldn't read the assistant's confirmations preference", { error });
    return null;
  }
  if (policy.skipsAll || policy.delegated.has(calledActionId)) return null;
  const switchesMode = mode !== "ask-except";
  let basis = { mode, edits: handEdits };
  return {
    offer: {
      label: entry.label,
      detail: entry.detail,
      ...(switchesMode ? { switchesMode: true as const } : {}),
    },
    approved: () => {
      try {
        basis = { mode: readMode(), edits: handEdits };
      } catch {
        // The offer's own reading still stands.
      }
    },
    commit: () => commitAssistantDelegation(sessionAgentId, calledActionId, basis),
  };
}

function commitAssistantDelegation(
  sessionAgentId: string | null,
  calledActionId: string,
  basis: { mode: HelpAssistantDaintreeConfirmations; edits: number }
): boolean {
  try {
    const mode = readMode();
    // Under "Ask, except for…" the action joins the list as it stands now,
    // whatever mode the dialog was approved under: everything already there
    // the person ticked. Any other mode must still be the one it was approved
    // under, so a newer choice stands.
    if (
      handEdits !== basis.edits ||
      (mode !== "ask-except" && mode !== basis.mode) ||
      readAssistantConfirmationPolicy(sessionAgentId).skipsAll
    ) {
      logger.info("Didn't hand an action over: Daintree confirmations changed while asking", {
        actionId: calledActionId,
      });
      return false;
    }
    const current = store.get("helpAssistant");
    // From another mode, only this action: ticks Settings kept from an
    // earlier "Ask, except for…" must not come back with it.
    const kept =
      mode === "ask-except"
        ? sanitizeDelegatedConfirmations(current?.daintreeConfirmationsExcept)
        : [];
    if (mode === "ask-except" && kept.includes(calledActionId)) return true;
    store.set("helpAssistant", {
      ...current,
      daintreeConfirmations: "ask-except",
      daintreeConfirmationsExcept: sanitizeDelegatedConfirmations([...kept, calledActionId]),
    });
    logger.info("Handed an action over to the assistant from its confirm dialog", {
      actionId: calledActionId,
      switchedMode: mode !== "ask-except",
    });
    return true;
  } catch (error) {
    logger.warn("Couldn't hand an action over to the assistant", { error });
    return false;
  }
}

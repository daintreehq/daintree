// eager-import-allow: reads the assistant's confirmation settings via store.get on each call
import { store } from "../../store.js";
import {
  assistantPolicySkips,
  resolveAssistantAgentSkip,
  resolveAssistantConfirmationPolicy,
  type AssistantConfirmationPolicy,
} from "../../../shared/utils/assistantDaintreeConfirmations.js";
import { isStorableAssistantAgentId } from "../../../shared/types/ipc/agentDefaults.js";

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

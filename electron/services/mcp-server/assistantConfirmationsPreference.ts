// eager-import-allow: reads the assistant's confirmation settings via store.get on each call
import { store } from "../../store.js";
import {
  assistantSkipsDaintreeConfirmations,
  resolveAssistantAgentSkip,
} from "../../../shared/utils/assistantDaintreeConfirmations.js";
import { isStorableAssistantAgentId } from "../../../shared/types/ipc/agentDefaults.js";

/**
 * Whether this machine's assistant runs with Daintree's confirmations skipped
 * (#12874), read live so "Always ask" takes effect on its next call. The
 * default follows the skip setting of the agent the session runs, else the
 * assistant's chosen agent (#14141).
 */
export function readAssistantConfirmationsSkipped(sessionAgentId: string | null): boolean {
  const helpAssistant = store.get("helpAssistant");
  const storedAgentId = helpAssistant?.agentId;
  const chosenAgentId = isStorableAssistantAgentId(storedAgentId) ? storedAgentId : null;
  return assistantSkipsDaintreeConfirmations(
    helpAssistant?.daintreeConfirmations,
    resolveAssistantAgentSkip(sessionAgentId ?? chosenAgentId, store.get("agentSettings")).skips
  );
}

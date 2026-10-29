import type { PluginSendToAgentRefusalReason, PluginSendToAgentResult } from "@shared/types/plugin";
import { selectActiveSlot, useHelpPanelStore } from "@/store/helpPanelStore";
import { resolveAssistantDraftRefusal } from "./draftTarget";
import {
  appendHandoffToDraft,
  readDraftTargetInputs,
  reportDraftAdded,
  reportDraftRefused,
  type AgentHandoffContent,
} from "./agentDraft";

function refuse(reason: PluginSendToAgentRefusalReason): PluginSendToAgentResult {
  reportDraftRefused(reason);
  return { status: "refused", reason };
}

/**
 * Append a handoff to the Assistant's draft, or refuse with the reason —
 * {@link draftAgentContext} for the session the Assistant panel shows. Never
 * submits. On success the panel opens on that session with its composer
 * focused, because the user handed it something to add an instruction to.
 */
export function draftAssistantContext(content: AgentHandoffContent): PluginSendToAgentResult {
  const help = useHelpPanelStore.getState();
  const { terminalId, agentId } = selectActiveSlot(help);
  if (terminalId === null) return refuse("unknown-terminal");
  const refusal = resolveAssistantDraftRefusal(
    readDraftTargetInputs(),
    terminalId,
    agentId ?? undefined
  );
  if (refusal !== null) return refuse(refusal);

  appendHandoffToDraft(terminalId, content);
  // Re-selecting the active slot is what leaves the global assistant view, which
  // would otherwise sit over the session that just took the draft.
  help.setActiveSlot(help.activeSlot);
  help.setOpen(true);
  help.requestFocus();
  reportDraftAdded("the Assistant");
  return { status: "drafted", terminalId };
}

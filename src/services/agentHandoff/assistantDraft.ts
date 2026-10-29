import type { PluginSendToAgentRefusalReason, PluginSendToAgentResult } from "@shared/types/plugin";
import { selectActiveSlot, useHelpPanelStore } from "@/store/helpPanelStore";
import { useFocusStore } from "@/store/focusStore";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
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
  // Revealed the way the panel's other reveals do it: a focus-mode hide would
  // keep an open panel off screen, and re-selecting the active slot is what
  // leaves the global assistant view that would otherwise cover the session.
  useFocusStore.getState().clearAssistantGesture();
  help.setActiveSlot(help.activeSlot);
  if (!help.isOpen) {
    suppressSidebarResizes();
    help.setOpen(true);
  }
  help.requestFocus();
  reportDraftAdded("the Assistant");
  return { status: "drafted", terminalId };
}

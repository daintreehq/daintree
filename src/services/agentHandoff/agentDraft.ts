import type {
  PluginAgentPane,
  PluginSendToAgentRefusalReason,
  PluginSendToAgentResult,
} from "@shared/types/plugin";
import { appendAgentContextToDraft, formatAgentContextBlock } from "@shared/utils/agentContextDrag";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import {
  formatTypingLocatorMessage,
  useTypingLocatorStore,
  type TypingLocatorMessage,
} from "@/store/typingLocatorStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { buildAgentPanes, resolveDraftRefusal, type DraftTargetInputs } from "./draftTarget";

/** What is being handed over: the text and the heading it is drafted under. */
export interface AgentHandoffContent {
  text: string;
  title?: string;
  sourceLabel?: string;
}

/** The draft gate's live inputs, read from the stores at call time. */
export function readDraftTargetInputs(): DraftTargetInputs {
  const panelState = usePanelStore.getState();
  const inputState = useTerminalInputStore.getState();
  return {
    panelsById: panelState.panelsById,
    backendStatus: panelState.backendStatus,
    hybridInputEnabled: inputState.hybridInputEnabled,
    voiceSubmittingIds: inputState.voiceSubmittingPanels,
    armedIds: useFleetArmingStore.getState().armedIds,
  };
}

/** Why `terminalId` would refuse a draft right now, or `null` when it would take one. */
export function getDraftRefusal(terminalId: string): PluginSendToAgentRefusalReason | null {
  return resolveDraftRefusal(readDraftTargetInputs(), terminalId);
}

/** This view's agent panes, as `host.agents.list()` and the picker read them. */
export function listAgentPanes(): PluginAgentPane[] {
  const panelState = usePanelStore.getState();
  return buildAgentPanes({
    ...readDraftTargetInputs(),
    panelIds: panelState.panelIds,
    focusedId: panelState.focusedId,
    worktrees: getCurrentViewStoreOrNull()?.getState().worktrees ?? new Map(),
    showAgentTaskTitles: usePreferencesStore.getState().showAgentTaskTitles,
  });
}

/**
 * The pill's wording per refusal, completing "Not added to draft: …". Phrased
 * for the user, not the plugin — they are the one who has to act on it.
 */
const REFUSAL_RECEIPT = {
  "unknown-terminal": "that agent is gone",
  "not-agent": "that pane isn't an agent",
  exited: "that agent has exited",
  "input-bar-off": "the input bar is off",
  "backend-unavailable": "the terminal service is unavailable",
  "input-locked": "that agent's input is locked",
  restarting: "that agent is restarting",
  "input-busy": "that agent is sending dictation",
  "not-in-grid": "that agent isn't in the grid",
  "fleet-armed": "that agent is in an armed fleet",
  "project-unavailable": "the project isn't open",
  "launch-failed": "the new agent didn't start",
  "prompt-open": "another picker is open",
} as const satisfies Record<PluginSendToAgentRefusalReason, string>;

/**
 * The pill for sighted users and a polite announcement for everyone else, the
 * same pair the file-reference insert reports through: the write happens in a
 * pane the user may not be looking at, and this is what makes it observable.
 */
function report(message: TypingLocatorMessage): void {
  useTypingLocatorStore.getState().showLocator(message);
  useAnnouncerStore.getState().announce(formatTypingLocatorMessage(message), "polite");
}

export function reportDraftRefused(reason: PluginSendToAgentRefusalReason): void {
  report({ kind: "draft-refused", lead: `Not added to draft: ${REFUSAL_RECEIPT[reason]}` });
}

/**
 * Append a handoff to an agent's draft, or refuse with the reason.
 *
 * Goes through the draft store — the sanctioned outside-write path voice, the
 * type-anywhere rescue and the file-reference insert already use — so it works
 * whether or not the pane's editor is mounted, and `HybridInputBar`'s
 * `externalDraftRevision` effect brings a mounted one up to date with the caret
 * at the end. Appends below whatever the user already typed and never submits:
 * the whole point is that they add the instruction.
 *
 * Deliberately does not move focus. A drop that wants the pane focused does
 * that itself, because the gesture was aimed at it; a plugin call was not.
 *
 * `skipChecks` is for a pane this handoff launched a moment ago, whose input
 * bar has not mounted yet — the gate would refuse it for being new, and the
 * draft store holds the text until it does.
 */
export function draftAgentContext(
  terminalId: string,
  content: AgentHandoffContent,
  options: { skipChecks?: boolean } = {}
): PluginSendToAgentResult {
  const refusal = options.skipChecks ? null : getDraftRefusal(terminalId);
  if (refusal !== null) {
    reportDraftRefused(refusal);
    return { status: "refused", reason: refusal };
  }

  const inputStore = useTerminalInputStore.getState();
  const projectId = useProjectStore.getState().currentProject?.id;
  const block = formatAgentContextBlock(content);
  inputStore.setDraftInput(
    terminalId,
    appendAgentContextToDraft(inputStore.getDraftInput(terminalId, projectId), block),
    projectId
  );
  inputStore.bumpExternalDraftRevision();

  const panelState = usePanelStore.getState();
  panelState.pingTerminal(terminalId);
  const panel = panelState.panelsById[terminalId];
  report({
    kind: "draft-added",
    lead: "Added to draft in",
    ...(panel ? { target: getTerminalDisplayTitle(panel, "full") } : {}),
  });
  return { status: "drafted", terminalId };
}

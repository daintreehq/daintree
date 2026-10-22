import type {
  PluginAgentPane,
  PluginSendToAgentRefusalReason,
  PluginSendToAgentResult,
} from "@shared/types/plugin";
import {
  AGENT_CONTEXT_FENCE_INFO,
  agentContextBlockRanges,
  appendAgentContextToDraft,
  formatAgentContextBlock,
  type AgentContextReferenceDragPayload,
} from "@shared/utils/agentContextDrag";
import { formatContextReference } from "@shared/utils/pluginContextReference";
import { rememberContextReferenceLabel } from "@/lib/contextReferenceLabels";
import { usePluginContextProvidersStore } from "@/store/pluginContextProvidersStore";
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
  busy: "too many handoffs at once",
} as const satisfies Record<PluginSendToAgentRefusalReason, string>;

/**
 * Whether any pane could take a draft at all: the input bar is on and the
 * terminal service is up. When not, a new agent would only get a draft nobody
 * can see, so the picker offers no creation rows.
 */
export function canDraftAnywhere(): boolean {
  const inputs = readDraftTargetInputs();
  return inputs.hybridInputEnabled && inputs.backendStatus === "connected";
}

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
  reportDraftNotAdded(REFUSAL_RECEIPT[reason]);
}

/** The refusal pill with a specific reason, completing "Not added to draft: …". */
export function reportDraftNotAdded(why: string): void {
  report({ kind: "draft-refused", lead: `Not added to draft: ${why}` });
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
 * Every write passes the gate, a freshly launched pane included — its input
 * bar may not have mounted yet, but the draft store holds the text until it
 * does, and a pane that locked or exited during the launch is refused like any
 * other.
 */
export function draftAgentContext(
  terminalId: string,
  content: AgentHandoffContent
): PluginSendToAgentResult {
  const refusal = getDraftRefusal(terminalId);
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

/**
 * What goes between a draft and a reference appended to it. The reference has
 * to land outside any handoff block — one left without its closing fence is
 * closed first — and never on a fence line, where it would stop the line from
 * closing its block. Otherwise a space, unless the draft already ends in one.
 */
function referenceSeparator(draft: string): string {
  if (draft.length === 0) return "";
  if (draft.includes(AGENT_CONTEXT_FENCE_INFO)) {
    // Judged by the rule `agentContextBlockRanges` keeps the block literal by:
    // only a line that is exactly the opening fence closes it.
    const last = agentContextBlockRanges(draft).at(-1);
    if (last !== undefined && last[1] === draft.length) {
      const lines = draft.slice(last[0]).split("\n");
      const fence = /^(`{3,})/.exec(lines[0] ?? "")?.[1];
      if (fence !== undefined && !lines.slice(1).includes(fence)) {
        return `${draft.endsWith("\n") ? "" : "\n"}${fence}\n`;
      }
    }
  }
  const lastLine = draft.slice(draft.lastIndexOf("\n") + 1);
  if (/^ {0,3}(`{3,}|~{3,})/.test(lastLine)) return "\n";
  return /\s$/.test(draft) ? "" : " ";
}

/**
 * Append a plugin context reference (#13795) to an agent's draft as the same
 * `@{prefix}:{id}` chip the `@` menu leaves, or refuse with the reason. The
 * item is read when the user sends, not now. Refused when no provider holds the
 * prefix in this project — the chip would go as typed — and otherwise gated
 * exactly like {@link draftAgentContext}.
 */
export function draftAgentContextReference(
  terminalId: string,
  reference: AgentContextReferenceDragPayload["reference"]
): PluginSendToAgentResult | { status: "unavailable" } {
  const holder = usePluginContextProvidersStore
    .getState()
    .entries.find((entry) => entry.status === "active" && entry.prefix === reference.prefix);
  if (!holder) {
    reportDraftNotAdded(`nothing in this project offers @${reference.prefix}:`);
    return { status: "unavailable" };
  }
  const refusal = getDraftRefusal(terminalId);
  if (refusal !== null) {
    reportDraftRefused(refusal);
    return { status: "refused", reason: refusal };
  }

  if (reference.label !== undefined) {
    rememberContextReferenceLabel(holder.pluginId, reference, reference.label);
  }
  const inputStore = useTerminalInputStore.getState();
  const projectId = useProjectStore.getState().currentProject?.id;
  const draft = inputStore.getDraftInput(terminalId, projectId);
  const separator = referenceSeparator(draft);
  inputStore.setDraftInput(
    terminalId,
    `${draft}${separator}${formatContextReference(reference)} `,
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

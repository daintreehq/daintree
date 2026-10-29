import type { McpRequester } from "@shared/types/ipc/mcpServer";
import { isPtyPanel } from "@shared/types/panel";
import type { McpConfirmRequester } from "@/store/mcpConfirmStore";
import { usePanelStore } from "@/store/panelStore";
import { selectOpenSlots, useHelpPanelStore } from "@/store/helpPanelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFocusStore } from "@/store/focusStore";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalDisplayTitle, getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";
import { sessionSlotLabel, trimSessionTabTitle } from "@/components/HelpPanel/sessionTabTitle";
import { navigateToNotificationSource } from "@/components/Notifications/notificationNavigation";

type PanelState = ReturnType<typeof usePanelStore.getState>;
type HelpPanelState = ReturnType<typeof useHelpPanelStore.getState>;

function livePanel(state: PanelState, terminalId: string) {
  // `Object.hasOwn`: `panelsById` is a plain object, and an id like
  // "constructor" must not resolve off its prototype.
  const panel = Object.hasOwn(state.panelsById, terminalId)
    ? state.panelsById[terminalId]
    : undefined;
  return panel === undefined || panel.location === "trash" ? undefined : panel;
}

/**
 * A worktree's name as the row gives it. Fails soft: `getCurrentViewStore()`
 * throws when no worktree view store is mounted, and a missing name costs the
 * row a qualifier, never the dialog.
 */
function worktreeNameFor(worktreeId: string): string | undefined {
  try {
    const worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
    return worktree?.branch || worktree?.name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lane holding this help session now. Matched by session id rather than a
 * remembered slot: a lane closed and reopened under the same number is a
 * different conversation, not the one that asked.
 */
function laneForHelpSession(state: HelpPanelState, helpSessionId: string): number | null {
  for (const slot of selectOpenSlots(state)) {
    if (state.sessions[slot]?.sessionId === helpSessionId) return slot;
  }
  return null;
}

/**
 * Name the requester main identified (#14992) from this view's own stores, the
 * way the pane's header and the Assistant's tab name it. Taken once, when the
 * request arrives. A requester this view can't find keeps its identity and
 * no name, so the dialog still says what class of surface asked.
 */
export function resolveMcpConfirmRequester(identity: McpRequester): McpConfirmRequester {
  const showTask = usePreferencesStore.getState().showAgentTaskTitles !== false;
  const panels = usePanelStore.getState();

  if (identity.kind === "assistant") {
    const help = useHelpPanelStore.getState();
    const slot = laneForHelpSession(help, identity.helpSessionId);
    if (slot === null) return { identity };
    const terminalId = help.sessions[slot]?.terminalId;
    const panel = terminalId ? livePanel(panels, terminalId) : undefined;
    const task = showTask && panel && isPtyPanel(panel) ? getTerminalTaskTitle(panel) : null;
    // Whole, not the tab's capped label: two tasks that share an opening would
    // otherwise read the same, and the row truncates in CSS anyway.
    return { identity, name: trimSessionTabTitle(task)?.fullTitle ?? sessionSlotLabel(slot) };
  }

  const panel = livePanel(panels, identity.terminalId);
  if (panel === undefined) return { identity };
  const name = getTerminalDisplayTitle(panel, "full", { showTask }).trim();
  const kindLabel = deriveTerminalChrome(panel).label;
  // A pane still called by its agent's name would say it twice.
  const titleSaysKind = panel.title.trim().toLowerCase() === kindLabel.toLowerCase();
  const worktreeName =
    panel.worktreeId !== undefined ? worktreeNameFor(panel.worktreeId) : undefined;
  return {
    identity,
    ...(name ? { name } : {}),
    ...(kindLabel && !titleSaysKind ? { kindLabel } : {}),
    ...(panel.worktreeId !== undefined ? { worktreeId: panel.worktreeId } : {}),
    ...(worktreeName ? { worktreeName } : {}),
  };
}

/**
 * What the dialog reads live rather than from the snapshot: whether the
 * requester is still here to be shown, and the worktree its pane is in now,
 * named only when that isn't the one on screen. Live because "Show pane" goes
 * to where the pane is, and the row must not send the user somewhere else.
 */
export function useMcpRequesterLiveState(requester: McpConfirmRequester | undefined): {
  present: boolean;
  otherWorktreeName?: string;
} {
  const identity = requester?.identity;
  const terminalId = identity?.kind === "pane" ? identity.terminalId : null;
  const helpSessionId = identity?.kind === "assistant" ? identity.helpSessionId : null;
  const paneLive = usePanelStore(
    (state) => terminalId !== null && livePanel(state, terminalId) !== undefined
  );
  // Only meaningful while the pane is live; read separately so a pane with no
  // worktree isn't mistaken for one that has gone.
  const paneWorktreeId = usePanelStore((state) =>
    terminalId === null ? undefined : livePanel(state, terminalId)?.worktreeId
  );
  const laneLive = useHelpPanelStore(
    (state) => helpSessionId !== null && laneForHelpSession(state, helpSessionId) !== null
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const worktreeId = paneLive ? paneWorktreeId : requester?.worktreeId;
  const otherWorktreeName =
    worktreeId === undefined || worktreeId === activeWorktreeId
      ? undefined
      : worktreeId === requester?.worktreeId
        ? requester.worktreeName
        : worktreeNameFor(worktreeId);
  return {
    present: paneLive || laneLive,
    ...(otherWorktreeName ? { otherWorktreeName } : {}),
  };
}

/**
 * Take the user to the requester. Resolves false when it is no longer here to
 * go to: a pane that closed is never stood in for by its worktree, and a lane
 * whose session ended is never stood in for by whatever took its slot.
 */
export async function showMcpRequester(identity: McpRequester): Promise<boolean> {
  if (identity.kind === "pane") {
    return navigateToNotificationSource({ panelId: identity.terminalId });
  }
  const help = useHelpPanelStore.getState();
  const slot = laneForHelpSession(help, identity.helpSessionId);
  if (slot === null) return false;
  // Focus mode can hide an open Assistant; showing a tab nobody can see would
  // leave the request stepped aside for nothing. Revealed the way the
  // Assistant toggle reveals it.
  if (!help.isOpen || useFocusStore.getState().gestureAssistantHidden) {
    suppressSidebarResizes();
    useFocusStore.getState().clearAssistantGesture();
  }
  help.setActiveSlot(slot);
  help.setOpen(true);
  help.requestFocus();
  return true;
}

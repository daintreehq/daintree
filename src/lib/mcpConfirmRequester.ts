import type { McpRequester } from "@shared/types/ipc/mcpServer";
import { isPtyPanel } from "@shared/types/panel";
import type { McpConfirmRequester } from "@/store/mcpConfirmStore";
import { usePanelStore } from "@/store/panelStore";
import { selectOpenSlots, useHelpPanelStore } from "@/store/helpPanelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
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
  // Fails soft: `getCurrentViewStore()` throws when no worktree view store is
  // mounted, and a missing worktree name costs the row a qualifier, never the
  // dialog.
  let worktreeName: string | undefined;
  if (panel.worktreeId !== undefined) {
    try {
      const worktree = getCurrentViewStore().getState().worktrees.get(panel.worktreeId);
      worktreeName = worktree?.branch || worktree?.name || undefined;
    } catch {
      worktreeName = undefined;
    }
  }
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
 * requester is still here to be shown, and whether its pane is in a worktree
 * other than the one on screen, which is when the row names the worktree.
 */
export function useMcpRequesterLiveState(requester: McpConfirmRequester | undefined): {
  present: boolean;
  inOtherWorktree: boolean;
} {
  const identity = requester?.identity;
  const terminalId = identity?.kind === "pane" ? identity.terminalId : null;
  const helpSessionId = identity?.kind === "assistant" ? identity.helpSessionId : null;
  const paneLive = usePanelStore(
    (state) => terminalId !== null && livePanel(state, terminalId) !== undefined
  );
  const laneLive = useHelpPanelStore(
    (state) => helpSessionId !== null && laneForHelpSession(state, helpSessionId) !== null
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const worktreeId = requester?.worktreeId;
  return {
    present: paneLive || laneLive,
    inOtherWorktree: worktreeId !== undefined && worktreeId !== activeWorktreeId,
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
  help.setActiveSlot(slot);
  help.setOpen(true);
  help.requestFocus();
  return true;
}

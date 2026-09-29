import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useUIStore } from "@/store/uiStore";
import { getWorktreeIdSet } from "@/store/storeAccessors";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import {
  resolveNotificationDestination,
  type NotificationDestination,
} from "@/lib/notificationDestination";

type NotificationContext = NotificationHistoryEntry["context"];

/**
 * The destination read fresh from the stores. Terminals get trashed and
 * worktrees deleted while a record sits in the inbox, so what the row rendered
 * with is only a hint.
 */
export function resolveLiveNotificationDestination(
  context: NotificationContext
): NotificationDestination {
  const panelId = context?.panelId;
  const panel = panelId ? usePanelStore.getState().panelsById[panelId] : undefined;
  const worktreeId = context?.worktreeId;
  const worktreeLive =
    !!worktreeId &&
    !!getWorktreeIdSet()?.has(worktreeId) &&
    !useWorktreeSelectionStore.getState().deletedWorktrees.has(worktreeId);
  return resolveNotificationDestination(context, {
    currentProjectId: getViewWorkspaceId() ?? useProjectStore.getState().currentProject?.id,
    panelLocation: panel?.location,
    panelWorktreeId: panel?.worktreeId,
    worktreeLive,
  });
}

/**
 * Takes the user to the notification's subject. Resolves true once there,
 * false when nothing live is left to go to or a step refused — the caller
 * closes the inbox only on true, so a dead link never dismisses it.
 */
export async function navigateToNotificationSource(context: NotificationContext): Promise<boolean> {
  const destination = resolveLiveNotificationDestination(context);
  if (destination.kind === "none") return false;

  const selection = useWorktreeSelectionStore.getState();

  if (destination.kind === "worktree") {
    const result = await actionService.dispatch("worktree.select", {
      worktreeId: destination.worktreeId,
    });
    if (!result.ok) return false;
    // Selecting restores the worktree's last focused panel as state; asking
    // for it by action is what moves the keyboard there too, so the inbox
    // does not close with focus stranded inside it.
    const focusedId = usePanelStore.getState().focusedId;
    const focused = focusedId ? usePanelStore.getState().panelsById[focusedId] : undefined;
    if (
      focusedId &&
      focused &&
      focused.location !== "trash" &&
      focused.worktreeId === destination.worktreeId
    ) {
      await actionService.dispatch("panel.focus", { panelId: focusedId });
    }
    return true;
  }

  const { panelId, worktreeId } = destination;
  if (worktreeId && worktreeId !== selection.activeWorktreeId) {
    const deleted = selection.deletedWorktrees.has(worktreeId);
    const live = !deleted && !!getWorktreeIdSet()?.has(worktreeId);
    // Recorded first so the switch restores this panel rather than whichever
    // one the worktree last had focused.
    if (deleted || live) selection.trackTerminalFocus(worktreeId, panelId);
    if (deleted) {
      // A surviving terminal of a deleted worktree. Session-only, as the
      // deleted card does it: a user-sourced selection would persist an id
      // that no longer exists as the restore target.
      selection.selectWorktree(worktreeId, { source: "focus" });
    } else if (live) {
      const selected = await actionService.dispatch("worktree.select", { worktreeId });
      if (!selected.ok) return false;
    }
    // Neither: a worktree this view doesn't know. `worktree.select` doesn't
    // validate, and the view would switch away again once it reconciled, so
    // the panel is focused where it is.
  }
  const focused = await actionService.dispatch("panel.focus", { panelId });
  return focused.ok;
}

/**
 * A row click, Enter on a row, and the row menu's "Go to source" all end here.
 * The inbox closes only after navigation has landed, so focus has already
 * moved to the destination and the bell's close handler leaves it there.
 */
export async function goToNotificationSource(context: NotificationContext): Promise<boolean> {
  const arrived = await navigateToNotificationSource(context);
  if (arrived) useUIStore.getState().closeNotificationCenter();
  return arrived;
}

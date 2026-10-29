import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useUIStore } from "@/store/uiStore";
import { getWorktreeIdSet } from "@/store/storeAccessors";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import {
  isOpenableWorkspace,
  resolveNotificationDestination,
  type NotificationDestination,
} from "@/lib/notificationDestination";
import { notify } from "@/lib/notify";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import type { ProjectFocusOnActivateIntent } from "@shared/types/ipc/project";

type NotificationContext = NotificationHistoryEntry["context"];
type WorkspaceDestination = Extract<NotificationDestination, { kind: "project" }>;

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
  const inView = getWorktreeIdSet();
  const { deletedWorktrees } = useWorktreeSelectionStore.getState();
  const worktreeLive =
    !!worktreeId && !!inView?.has(worktreeId) && !deletedWorktrees.has(worktreeId);
  const panelWorktreeId = panel?.worktreeId;
  const panelWorktreeShown =
    !panelWorktreeId || !!inView?.has(panelWorktreeId) || deletedWorktrees.has(panelWorktreeId);
  const { currentProject, projects } = useProjectStore.getState();
  return resolveNotificationDestination(context, {
    currentProjectId: getViewWorkspaceId() ?? currentProject?.id,
    panelLocation: panel?.location,
    panelWorktreeId,
    panelWorktreeShown,
    worktreeLive,
    otherWorkspaceOpenable: isOpenableWorkspace(
      context?.projectId,
      projects,
      useScratchStore.getState().scratches
    ),
  });
}

/**
 * Takes the user to the notification's subject. Resolves true once there,
 * false when nothing live is left to go to or a step refused — the caller
 * closes the inbox only on true, so a dead link never dismisses it.
 */
export async function navigateToNotificationSource(context: NotificationContext): Promise<boolean> {
  const destination = resolveLiveNotificationDestination(context);
  // Another workspace is reached only by switching away from this view, which
  // is the inbox's decision to make (see goToNotificationSource).
  if (destination.kind === "none" || destination.kind === "project") return false;

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
    // Recorded first so the switch restores this panel rather than whichever
    // one the worktree last had focused.
    selection.trackTerminalFocus(worktreeId, panelId);
    if (selection.deletedWorktrees.has(worktreeId)) {
      // A surviving terminal of a deleted worktree. Session-only, as the
      // deleted card does it: a user-sourced selection would persist an id
      // that no longer exists as the restore target.
      selection.selectWorktree(worktreeId, { source: "focus" });
    } else {
      // The resolver only returns a panel whose worktree this view has.
      const selected = await actionService.dispatch("worktree.select", { worktreeId });
      if (!selected.ok) return false;
    }
  }
  const focused = await actionService.dispatch("panel.focus", { panelId });
  return focused.ok;
}

/**
 * Reads the row the way the `u` toggle does: a thread's other unarchived
 * entries go with its head, since the row is one line to the user. Archive
 * stays its own step, and an entry pruned meanwhile is simply not found.
 */
function markRowRead(entryId: string): void {
  const { entries, markIdsRead } = useNotificationHistoryStore.getState();
  const head = entries.find((e) => e.id === entryId);
  if (!head) return;
  const ids = entries
    .filter(
      (e) =>
        e.id === head.id ||
        (!!head.correlationId && e.correlationId === head.correlationId && !e.archivedAt)
    )
    .map((e) => e.id);
  markIdsRead(ids);
}

/**
 * What to do once the other workspace's view is up: its panel, or the worktree
 * when the panel has gone by then.
 */
function landingIntentFor({
  panelId,
  worktreeId,
}: WorkspaceDestination): ProjectFocusOnActivateIntent | undefined {
  if (panelId) return { intent: "focus-panel", panelId, ...(worktreeId ? { worktreeId } : {}) };
  if (worktreeId) return { intent: "focus-worktree", worktreeId };
  return undefined;
}

/**
 * Switches to the record's workspace with its address riding along, for the
 * incoming view to land on. A project switch reports its own failure, with a
 * Try again that keeps the address; a scratch switch rejects to here.
 */
function switchToNotificationWorkspace(destination: WorkspaceDestination): void {
  const { projectId } = destination;
  const focusIntent = landingIntentFor(destination);
  const switching = isScratchWorkspaceId(projectId)
    ? useScratchStore.getState().switchScratch(projectId, { focusIntent })
    : useProjectStore.getState().switchProject(projectId, { focusIntent });
  void switching.catch((error: unknown) => {
    logWarn("Couldn't switch to a notification's workspace", {
      error: formatErrorMessage(error, "unknown"),
    });
    notify({
      type: "error",
      title: "Couldn't open the source",
      message: formatErrorMessage(error, "Daintree couldn't switch to the workspace it's in."),
      context: { eventKind: "uiFeedback" },
      actions: [
        {
          label: "Try again",
          variant: "primary",
          onClick: () => switchToNotificationWorkspace(destination),
        },
      ],
    });
  });
}

/**
 * A row click, Enter on a row, and the row menu's "Go to source" all end here.
 * The inbox closes only after navigation has landed, so focus has already
 * moved to the destination and the bell's close handler leaves it there. The
 * row is marked read on that same arrival and never on a refusal, so a dead
 * link leaves it unread.
 *
 * Another workspace is the exception: the switch replaces this view, and its
 * landing happens in a view that can't report back. So the inbox closes as the
 * switch starts, and the row keeps its read state, unread until the user marks
 * it, since nothing here learns that the source was reached. A switch that
 * fails says so, and the row is still in the inbox.
 *
 * Resolves false only when the inbox kept the row: nowhere was left to go, or
 * a step refused.
 */
export async function goToNotificationSource(
  context: NotificationContext,
  entryId: string
): Promise<boolean> {
  const destination = resolveLiveNotificationDestination(context);
  if (destination.kind === "project") {
    useUIStore.getState().closeNotificationCenter();
    switchToNotificationWorkspace(destination);
    return true;
  }
  const arrived = await navigateToNotificationSource(context);
  if (arrived) {
    markRowRead(entryId);
    useUIStore.getState().closeNotificationCenter();
  }
  return arrived;
}

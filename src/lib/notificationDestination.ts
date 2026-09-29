// Where a notification row takes you. `context` is the address of the
// notification's subject, written when it fired; whether anything still lives
// at that address is a question for now, so this decides from facts read at
// the moment of asking. No store imports — the hook and the click-time reader
// each supply their own snapshot.
import type { PanelLocation } from "@shared/types";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

type NotificationContext = NotificationHistoryEntry["context"];

export type NotificationUnavailableReason = "other-project" | "panel-trashed" | "gone";

export type NotificationDestination =
  | { kind: "panel"; panelId: string; worktreeId?: string }
  | { kind: "worktree"; worktreeId: string }
  /** `reason` is null when the record never named a panel or worktree. */
  | { kind: "none"; reason: NotificationUnavailableReason | null };

export interface NotificationDestinationFacts {
  /** The view's own project, or null when none is open. */
  currentProjectId: string | null | undefined;
  /** The named panel's location, or undefined when no such panel exists. */
  panelLocation: PanelLocation | undefined;
  /** The named panel's worktree now — a panel can have moved since. */
  panelWorktreeId: string | undefined;
  /**
   * Whether this view can show the panel's worktree: live, or a deleted one
   * whose terminals it still keeps. A panel with no worktree always can.
   */
  panelWorktreeShown: boolean;
  /** Whether `context.worktreeId` is a worktree this view still has. */
  worktreeLive: boolean;
}

/** Said in the row's metadata line and as the disabled "Go to source" reason. */
export const NOTIFICATION_UNAVAILABLE_LABEL: Record<NotificationUnavailableReason, string> = {
  "other-project": "In another project",
  "panel-trashed": "Panel in trash",
  gone: "Source unavailable",
};

export function hasNotificationAddress(context: NotificationContext): boolean {
  return !!context?.panelId || !!context?.worktreeId;
}

/**
 * Renderer state is per project view, so another project's panels and
 * worktrees are not here to find — and with no project open, nothing that
 * names one is. A record with no project id predates the field and belongs to
 * the view it is shown in.
 */
export function isOtherProjectContext(
  context: NotificationContext,
  currentProjectId: string | null | undefined
): boolean {
  const projectId = context?.projectId;
  return !!projectId && projectId !== currentProjectId;
}

/**
 * The panel if it still exists outside the trash, otherwise the worktree if
 * this view still has it. Never the project: history lives in the current
 * project view, so "go to this project" goes nowhere.
 */
export function resolveNotificationDestination(
  context: NotificationContext,
  facts: NotificationDestinationFacts
): NotificationDestination {
  if (!hasNotificationAddress(context)) return { kind: "none", reason: null };
  if (isOtherProjectContext(context, facts.currentProjectId)) {
    return { kind: "none", reason: "other-project" };
  }
  const panelId = context?.panelId;
  if (
    panelId &&
    facts.panelLocation !== undefined &&
    facts.panelLocation !== "trash" &&
    facts.panelWorktreeShown
  ) {
    return { kind: "panel", panelId, worktreeId: facts.panelWorktreeId };
  }
  const worktreeId = context?.worktreeId;
  if (worktreeId && facts.worktreeLive) return { kind: "worktree", worktreeId };
  if (panelId && facts.panelLocation === "trash") return { kind: "none", reason: "panel-trashed" };
  return { kind: "none", reason: "gone" };
}

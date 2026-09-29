import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationStore } from "@/store/notificationStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { Toaster } from "@/components/ui/toaster";
import { MENUS_PROJECT } from "./menusShims";

/**
 * The notification surfaces' menus: the inbox (its two toolbar menus and a
 * row's options menu) and a toast's options menu. Every entry carries a project
 * and an event kind, which is what adds the Silence and Mute rows; the build
 * failure also carries a correlation id and a source panel, which add Snooze,
 * Copy correlation ID, Go to source and Report on GitHub.
 */

const NOW = Date.now();
const noop = () => {};

function historyEntry(over: Partial<NotificationHistoryEntry>): NotificationHistoryEntry {
  return {
    id: crypto.randomUUID(),
    type: "info",
    message: "",
    timestamp: NOW,
    seenAsToast: true,
    summarized: false,
    countable: true,
    archivedAt: null,
    ...over,
  };
}

const CONTEXT = { projectId: MENUS_PROJECT.id, worktreeId: "wt-main" };

const HISTORY: NotificationHistoryEntry[] = [
  historyEntry({
    correlationId: "build",
    type: "error",
    title: "Build failed on design/menus-popovers",
    message: "tsc exited 2 — 3 errors in src/components/ui/dropdown-menu.tsx",
    timestamp: NOW - 60_000,
    seenAsToast: false,
    context: { ...CONTEXT, panelId: "p-build", eventKind: "git" },
  }),
  historyEntry({
    type: "success",
    title: "Claude finished",
    message: "Aligned the menu row paddings and all tests pass.",
    timestamp: NOW - 20 * 60_000,
    context: { ...CONTEXT, eventKind: "completed" },
  }),
  historyEntry({
    message: "Synced 4 worktrees with origin in 1.4s",
    timestamp: NOW - 90 * 60_000,
    context: { ...CONTEXT, eventKind: "git" },
  }),
];

export type NotificationsSceneId = "notifications" | "toaster";

export function seedNotificationsScene(scene: NotificationsSceneId): void {
  usePluginContextMenuItemsStore.setState({ entries: [], init: noop });
  useProjectStore.setState({ currentProject: MENUS_PROJECT, projects: [MENUS_PROJECT] });
  if (scene === "notifications") {
    useNotificationHistoryStore.setState({
      entries: HISTORY,
      unreadCount: HISTORY.filter((e) => !e.seenAsToast).length,
    });
    return;
  }
  useNotificationStore.setState({
    notifications: [
      {
        id: "t-push",
        type: "error",
        priority: "high",
        title: "Push rejected",
        message: "origin/design/menus-popovers has commits you don't have. Pull, then push again.",
        context: { ...CONTEXT, eventKind: "git" },
      },
    ],
  });
}

export function NotificationsScene({ scene }: { scene: NotificationsSceneId }) {
  if (scene === "toaster") return <Toaster />;
  return (
    <div
      data-testid="menus-notification-center"
      className="relative w-[380px] rounded-[var(--radius-md)] border border-divider bg-surface-panel"
    >
      <NotificationCenter open onClose={noop} />
    </div>
  );
}

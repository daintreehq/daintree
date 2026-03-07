import { useNotificationStore } from "@/store/notificationStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export function fireWatchNotification(
  panelId: string,
  panelTitle: string,
  agentState: string,
  worktreeId?: string
): void {
  const label = panelTitle || panelId;
  const isWaiting = agentState === "waiting";
  const title = isWaiting ? "Agent waiting for input" : "Agent task completed";
  const message = isWaiting ? `${label} is waiting for your input` : `${label} finished its task`;

  useNotificationStore.getState().addNotification({
    type: isWaiting ? "warning" : "success",
    title,
    message,
    duration: 12000,
    action: {
      label: "Go to terminal",
      onClick: () => {
        if (worktreeId) {
          useWorktreeSelectionStore.getState().setActiveWorktree(worktreeId);
        }
        useTerminalStore.getState().setFocused(panelId, true);
      },
    },
  });
}

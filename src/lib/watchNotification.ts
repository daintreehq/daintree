import { notify } from "@/lib/notify";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useUIStore } from "@/store/uiStore";

export function fireWatchNotification(
  panelId: string,
  panelTitle: string,
  agentState: string,
  worktreeId?: string
): void {
  const label = panelTitle || panelId;
  const isWaiting = agentState === "waiting";

  if (isWaiting) {
    notify({
      type: "warning",
      priority: "high",
      title: "Agent waiting for input",
      message: `${label} is waiting for your input`,
      duration: 12000,
      correlationId: panelId,
      action: {
        label: "Go to terminal",
        onClick: () => {
          if (worktreeId) {
            useWorktreeSelectionStore.getState().setActiveWorktree(worktreeId);
          }
          useTerminalStore.getState().setFocused(panelId, true);
        },
        actionId: "panel.focus",
        actionArgs: { panelId, ...(worktreeId ? { worktreeId } : {}) },
      },
    });
    return;
  }

  const navigateToPanel = (targetPanelId: string, targetWorktreeId?: string) => {
    if (targetWorktreeId) {
      useWorktreeSelectionStore.getState().setActiveWorktree(targetWorktreeId);
    }
    useTerminalStore.getState().setFocused(targetPanelId, true);
  };

  notify({
    type: "success",
    priority: "high",
    title: "Agent task completed",
    message: `${label} finished its task`,
    duration: 12000,
    correlationId: panelId,
    action: {
      label: "Go to terminal",
      onClick: () => navigateToPanel(panelId, worktreeId),
      actionId: "panel.focus",
      actionArgs: { panelId, ...(worktreeId ? { worktreeId } : {}) },
    },
    coalesce: {
      key: "agent:completed",
      windowMs: 2000,
      buildTitle: () => "Agent tasks completed",
      buildMessage: (count) => `${count} agents finished their tasks`,
      buildInboxMessage: (count) => `${count} agents finished their tasks`,
      buildAction: (count) => {
        if (count === 1) {
          return {
            label: "Go to terminal",
            onClick: () => navigateToPanel(panelId, worktreeId),
            actionId: "panel.focus",
            actionArgs: { panelId, ...(worktreeId ? { worktreeId } : {}) },
          };
        }
        return {
          label: "View all",
          onClick: () => useUIStore.getState().openNotificationCenter(),
        };
      },
    },
  });
}

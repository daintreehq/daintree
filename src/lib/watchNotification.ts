import { notify } from "@/lib/notify";
import { panelNotificationAddress } from "@/lib/notificationAddress";
import { navigateToNotificationSource } from "@/components/Notifications/notificationNavigation";
import { usePanelStore } from "@/store/panelStore";
import { useUIStore } from "@/store/uiStore";

/**
 * "Go to terminal": the panel's worktree, then the panel, the way the inbox's
 * Go to source goes there. Focusing alone switched worktrees only through the
 * focus-follow subscription, which never fires for the panel that is already
 * the focused one — and a worktree with no remembered terminal leaves it so.
 * Rejects when the panel is gone or trashed, so the toast never says it
 * opened something it didn't.
 */
async function goToPanel(panelId: string): Promise<void> {
  if (!(await navigateToNotificationSource({ panelId }))) {
    throw new Error("The terminal is no longer available");
  }
  usePanelStore.getState().pingTerminal(panelId);
}

export function fireWatchNotification(
  panelId: string,
  panelTitle: string,
  agentState: string
): void {
  const label = panelTitle || panelId;
  // The panel itself shows exited/waiting/completed, so a toast is redundant
  // while it's focused — these are the events suppression exists for.
  const address = panelNotificationAddress(panelId);

  if (agentState === "exited") {
    notify({
      type: "info",
      priority: "high",
      title: "Process exited",
      message: `${label} process has exited`,
      duration: 5000,
      correlationId: panelId,
      context: { eventKind: "agent", ...address },
      suppressWhenOriginVisible: true,
      action: {
        label: "Go to terminal",
        successLabel: "Opened",
        onClick: () => goToPanel(panelId),
        actionId: "panel.focus",
        actionArgs: { panelId },
      },
    });
    return;
  }

  if (agentState === "waiting") {
    notify({
      type: "warning",
      priority: "high",
      title: "Agent waiting for input",
      message: `${label} is waiting for your input`,
      duration: 12000,
      correlationId: panelId,
      context: { eventKind: "agent", ...address },
      suppressWhenOriginVisible: true,
      action: {
        label: "Go to terminal",
        successLabel: "Opened",
        onClick: () => goToPanel(panelId),
        actionId: "panel.focus",
        actionArgs: { panelId },
      },
    });
    return;
  }

  notify({
    type: "success",
    priority: "high",
    title: "Agent task completed",
    message: `${label} finished its task`,
    duration: 5000,
    correlationId: panelId,
    context: { eventKind: "completed", ...address },
    suppressWhenOriginVisible: true,
    action: {
      label: "Go to terminal",
      successLabel: "Opened",
      onClick: () => goToPanel(panelId),
      actionId: "panel.focus",
      actionArgs: { panelId },
    },
    coalesce: {
      key: "agent:completed",
      windowMs: 15000,
      buildTitle: () => "Agent tasks completed",
      buildMessage: (count) => `${count} agents finished their tasks`,
      buildInboxMessage: (count) => `${count} agents finished their tasks`,
      buildAction: () => ({
        label: "View all",
        onClick: () => useUIStore.getState().openNotificationCenter(),
      }),
    },
  });
}

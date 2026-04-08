import { notify } from "@/lib/notify";
import { usePanelStore } from "@/store/panelStore";
import { useUIStore } from "@/store/uiStore";

export function fireWatchNotification(
  panelId: string,
  panelTitle: string,
  agentState: string
): void {
  const label = panelTitle || panelId;

  if (agentState === "exited") {
    notify({
      type: "info",
      priority: "high",
      title: "Process exited",
      message: `${label} process has exited`,
      duration: 5000,
      correlationId: panelId,
      action: {
        label: "Go to terminal",
        onClick: () => {
          usePanelStore.getState().setFocused(panelId, true);
        },
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
      action: {
        label: "Go to terminal",
        onClick: () => {
          usePanelStore.getState().setFocused(panelId, true);
        },
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
    action: {
      label: "Go to terminal",
      onClick: () => {
        usePanelStore.getState().setFocused(panelId, true);
      },
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

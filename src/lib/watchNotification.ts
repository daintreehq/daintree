import { notify } from "@/lib/notify";
import { panelNotificationAddress } from "@/lib/notificationAddress";
import { usePanelStore } from "@/store/panelStore";
import { useUIStore } from "@/store/uiStore";
import { exitProjectHome } from "@/store/storeAccessors";

/**
 * "Go to terminal": focus the panel and make sure it is on screen. A grid
 * panel is hidden while the project's Home shows, so leave Home for one; the
 * dock stays visible beside it.
 */
function goToPanel(panelId: string): void {
  const state = usePanelStore.getState();
  const panel = state.panelsById[panelId];
  if (panel !== undefined && (panel.location === "grid" || panel.location === undefined)) {
    exitProjectHome();
  }
  state.setFocused(panelId, true);
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
        onClick: () => {
          goToPanel(panelId);
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
      context: { eventKind: "agent", ...address },
      suppressWhenOriginVisible: true,
      action: {
        label: "Go to terminal",
        successLabel: "Opened",
        onClick: () => {
          goToPanel(panelId);
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
    context: { eventKind: "completed", ...address },
    suppressWhenOriginVisible: true,
    action: {
      label: "Go to terminal",
      successLabel: "Opened",
      onClick: () => {
        goToPanel(panelId);
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

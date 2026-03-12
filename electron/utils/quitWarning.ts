import type { AgentAvailabilityStore } from "../services/AgentAvailabilityStore.js";

type Dialog = typeof import("electron").dialog;

const ACTIVE_STATES = new Set(["working", "running"]);

export function getActiveAgentCount(store: AgentAvailabilityStore): number {
  return store.getAgentsByAvailability().filter((a) => ACTIVE_STATES.has(a.state)).length;
}

export async function showQuitWarning(
  activeCount: number,
  showMessageBox: Dialog["showMessageBox"]
): Promise<boolean> {
  const { response } = await showMessageBox({
    type: "warning",
    buttons: ["Quit Anyway", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Agents are working",
    message: `${activeCount} agent${activeCount > 1 ? "s are" : " is"} currently working`,
    detail: "Quitting now will interrupt active agents. Any unsaved progress may be lost.",
  });

  return response === 0;
}

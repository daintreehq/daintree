import { idleTerminalClient } from "@/clients/idleTerminalClient";
import { useProjectStore } from "@/store/projectStore";

/**
 * The idle-terminal reminder's Sleep project button. Main runs the same Sleep
 * either way (#13845); what differs is this window's part in it.
 *
 * The reminder sits in the inbox, so the project it names may be the one this
 * window is showing by the time it's pressed. That one goes through the
 * window's own Sleep, which settles the pending layout save before main writes
 * the captured session ids into it, and drops the window to the no-project
 * state as its own request rather than as a sleep "in another window".
 */
export async function sleepIdleTerminalProject(projectId: string): Promise<void> {
  const projects = useProjectStore.getState();
  if (projects.currentProject?.id === projectId) {
    await projects.sleepProject(projectId);
    return;
  }
  await idleTerminalClient.closeProject(projectId);
}

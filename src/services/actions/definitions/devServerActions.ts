import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { projectClient } from "@/clients";
import { useTerminalStore } from "@/store/terminalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

export function registerDevServerActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("devServer.start", () => ({
    id: "devServer.start",
    title: "Start Dev Server",
    description: "Start the configured dev server and open a dev preview panel",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const currentProject = useProjectStore.getState().currentProject;
      if (!currentProject) {
        throw new Error("No project is currently open");
      }

      const settings = await projectClient.getSettings(currentProject.id);
      const devServerCommand = settings?.devServerCommand?.trim();
      if (!devServerCommand) {
        throw new Error(
          "No dev server command configured. Open project settings to configure one."
        );
      }

      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const activeWorktree = activeWorktreeId
        ? useWorktreeDataStore.getState().worktrees.get(activeWorktreeId)
        : null;
      const cwd = activeWorktree?.path ?? currentProject.path;

      await useTerminalStore.getState().addTerminal({
        kind: "dev-preview",
        title: "Dev Server",
        cwd,
        worktreeId: activeWorktreeId ?? undefined,
        location: "grid",
      });
    },
  }));
}

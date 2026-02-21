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
    title: "Open Dev Preview",
    description: "Open a dev preview panel and start the dev server when configured",
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
        devCommand: devServerCommand || undefined,
      });
    },
  }));
}

import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { projectClient } from "@/clients";
import { useTerminalStore } from "@/store/terminalStore";

export function registerDevServerActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("devServer.openDetected", () => ({
    id: "devServer.openDetected",
    title: "Open Detected Dev Server",
    description: "Open a detected dev server URL in the system browser",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async (args: unknown) => {
      const { url } = args as { url?: string };
      if (!url) {
        throw new Error("No URL provided");
      }
      await window.electron.system.openExternal(url);
    },
  }));

  actions.set("devServer.start", () => ({
    id: "devServer.start",
    title: "Open Dev Preview",
    description: "Open a dev preview panel and start the dev server when configured",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async (_args: unknown, ctx: ActionContext) => {
      if (!ctx.projectId) {
        throw new Error("No project is currently open");
      }

      const settings = await projectClient.getSettings(ctx.projectId);
      const devServerCommand = settings?.devServerCommand?.trim();

      const cwd = ctx.activeWorktreePath ?? ctx.projectPath;

      await useTerminalStore.getState().addTerminal({
        kind: "dev-preview",
        title: "Dev Server",
        cwd,
        worktreeId: ctx.activeWorktreeId,
        location: "grid",
        devCommand: devServerCommand || undefined,
      });
    },
  }));
}

import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { projectClient } from "@/clients";
import { usePanelStore } from "@/store/panelStore";

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
    run: async (_args: unknown, ctx: ActionContext) => {
      if (!ctx.projectId) {
        throw new Error("No project is currently open");
      }

      const settings = await projectClient.getSettings(ctx.projectId);
      const devServerCommand = settings?.devServerCommand?.trim();

      const cwd = ctx.activeWorktreePath ?? ctx.projectPath;

      await usePanelStore.getState().addPanel({
        kind: "dev-preview",
        title: "Dev Server",
        cwd,
        worktreeId: ctx.activeWorktreeId,
        location: "grid",
        devCommand: devServerCommand || undefined,
      });
    },
  }));

  actions.set("devPreview.stop", () => ({
    id: "devPreview.stop",
    title: "Stop Dev Server",
    description: "Stop the currently focused dev preview server",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async (_args: unknown, ctx: ActionContext) => {
      if (!ctx.projectId) {
        throw new Error("No project is currently open");
      }

      const panelId = ctx.focusedTerminalId;
      if (!panelId) {
        throw new Error("No dev preview panel is focused");
      }

      await window.electron.devPreview.stop({
        panelId,
        projectId: ctx.projectId,
      });
    },
  }));
}

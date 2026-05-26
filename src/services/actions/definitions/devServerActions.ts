import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { isAbsolute } from "@shared/utils/path";
import { projectClient } from "@/clients";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";

function readActiveWorktreePath(activeWorktreeId: string | undefined): string | undefined {
  if (!activeWorktreeId) return undefined;
  try {
    return getCurrentViewStore().getState().worktrees.get(activeWorktreeId)?.path;
  } catch {
    return undefined;
  }
}

function firstAbsolutePath(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => typeof candidate === "string" && isAbsolute(candidate));
}

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
      const currentProject =
        useProjectStore.getState().currentProject ??
        (await projectClient.getCurrent().catch(() => null));
      const projectId = ctx.projectId ?? currentProject?.id;

      if (!projectId) {
        throw new Error("No project is currently open");
      }

      const settings = await projectClient.getSettings(projectId);
      const devServerCommand = settings?.devServerCommand?.trim();

      const cwd = firstAbsolutePath(
        ctx.activeWorktreePath,
        readActiveWorktreePath(ctx.activeWorktreeId),
        ctx.projectPath,
        currentProject?.path
      );
      if (!cwd) {
        throw new Error("No absolute project path is available for Dev Preview");
      }

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

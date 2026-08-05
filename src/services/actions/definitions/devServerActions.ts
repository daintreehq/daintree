import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { isAbsolute } from "@shared/utils/path";
import { projectClient } from "@/clients";
import { readDevServerCommand } from "@/utils/devServerCommand";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { isDevPreviewPanel } from "@shared/types/panel";

/**
 * Palette gate for `devPreview.stop`: its `run()` needs an open project and a
 * focused dev-preview panel and throws otherwise. Reads the panel store rather
 * than the action context (which doesn't carry the focused panel kind);
 * dispatch never evaluates this, so explicit-arg callers are unaffected.
 */
function isDevPreviewStoppable(ctx: { projectId?: string }): boolean {
  if (!ctx.projectId) return false;
  const { focusedId, getTerminal } = usePanelStore.getState();
  if (!focusedId) return false;
  const panel = getTerminal(focusedId);
  return Boolean(panel && isDevPreviewPanel(panel));
}

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

      const devServerCommand = await readDevServerCommand(projectId);

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
        devCommand: devServerCommand,
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
    palette: {
      mode: "requireContext",
      isReady: (ctx) => isDevPreviewStoppable(ctx),
      reason: "Focus a dev preview to stop it",
    },
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

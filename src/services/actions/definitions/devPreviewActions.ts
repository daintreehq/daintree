import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";

const argsSchema = z
  .object({
    panelId: z.string().optional(),
    projectId: z.string().optional(),
  })
  .optional();

function resolveTarget(args: unknown, ctx: ActionContext): { panelId: string; projectId: string } {
  const parsed = argsSchema.parse(args);
  const { panelId, projectId } = parsed ?? {};
  const targetPanelId = panelId ?? usePanelStore.getState().focusedId;
  const targetProjectId = projectId ?? ctx.projectId;
  if (!targetPanelId) {
    throw new Error("No dev preview panel is focused");
  }
  if (!targetProjectId) {
    throw new Error("No project is currently open");
  }
  return { panelId: targetPanelId, projectId: targetProjectId };
}

export function registerDevPreviewActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("devPreview.reloadPreview", () => ({
    id: "devPreview.reloadPreview",
    title: "Reload preview",
    description: "Reload the dev preview webview without restarting the dev server",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema,
    run: async (args: unknown) => {
      const parsed = argsSchema.parse(args);
      const { panelId } = parsed ?? {};
      const targetId = panelId ?? usePanelStore.getState().focusedId;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent("daintree:hard-reload-browser", { detail: { id: targetId } })
        );
      }
    },
  }));

  actions.set("devPreview.restart", () => ({
    id: "devPreview.restart",
    title: "Restart dev server",
    description: "Stop and respawn the dev server, keeping caches and dependencies",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const target = resolveTarget(args, ctx);
      await window.electron.devPreview.restart(target);
    },
  }));

  actions.set("devPreview.restartAndClearCache", () => ({
    id: "devPreview.restartAndClearCache",
    title: "Restart and clear cache",
    description: "Wipe framework build caches (.next, .vite, .turbo) then respawn the dev server",
    category: "devServer",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Wipes framework build caches (.next, .vite, .turbo) and respawns the dev server. Caches regenerate on next build.",
    argsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const target = resolveTarget(args, ctx);
      await window.electron.devPreview.restartAndClearCache(target);
    },
  }));

  actions.set("devPreview.reinstallAndRestart", () => ({
    id: "devPreview.reinstallAndRestart",
    title: "Reinstall and restart",
    description: "Remove node_modules, reinstall dependencies, then respawn the dev server",
    category: "devServer",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Removes node_modules, reinstalls dependencies, and respawns the dev server. Recovery requires a full reinstall, network and lockfile dependent.",
    argsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const target = resolveTarget(args, ctx);
      await window.electron.devPreview.reinstallAndRestart(target);
    },
  }));
}

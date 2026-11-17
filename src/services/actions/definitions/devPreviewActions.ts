import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { isDevPreviewPanel } from "@shared/types/panel";

const argsSchema = z
  .object({
    panelId: z.string().optional(),
    projectId: z.string().optional(),
  })
  .optional();

/**
 * Palette gate for the dev-preview actions: their `run()` resolves the target
 * from `usePanelStore.getState().focusedId` and throws when nothing suitable is
 * focused. Used as the `requireContext.isReady` predicate so the palette dims
 * the row with a reason instead of dispatching `{}` into a throw. Reads the
 * panel store directly (the action context doesn't carry the focused panel
 * kind); dispatch never evaluates this, so context-menu/MCP calls with an
 * explicit `panelId` are unaffected.
 */
function isDevPreviewFocused(): boolean {
  const { focusedId, getTerminal } = usePanelStore.getState();
  if (!focusedId) return false;
  const panel = getTerminal(focusedId);
  return Boolean(panel && isDevPreviewPanel(panel));
}

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
    description:
      "Reload the dev preview page without restarting its dev server. Try this first when the preview looks stale; restart the server only when its process is wedged or its config changed.",
    paletteDescription: "Reload the dev preview page without restarting its server",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["stale"],
    palette: {
      mode: "requireContext",
      isReady: () => isDevPreviewFocused(),
      reason: "Focus a dev preview to reload it",
    },
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
    description:
      "Stop the dev server and start it again, keeping caches and dependencies. The preview is down until it returns; reload the page first unless the server process itself is the problem.",
    paletteDescription: "Stop and restart the dev server, keeping caches and dependencies",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: {
      mode: "requireContext",
      // resolveTarget() needs both a focused dev preview AND ctx.projectId, and
      // throws without either — gate on both so the row matches run()'s success.
      isReady: (ctx) => Boolean(ctx.projectId) && isDevPreviewFocused(),
      reason: "Focus a dev preview to restart it",
    },
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
    // danger:"confirm" with the confirm wired at the DevPreviewPane call site
    // (DevPreviewDestructiveConfirmDialog), NOT in run(). The palette dispatches
    // with source:"user", which ActionService does not gate, so a palette pick
    // would wipe caches with no confirmation — a D1 bypass. Keep it out of the
    // palette; it stays reachable from the dev-preview panel menu (with confirm).
    palette: { mode: "hidden" },
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
    // danger:"confirm" with the confirm wired at the DevPreviewPane call site,
    // not in run() — see devPreview.restartAndClearCache above. Hidden from the
    // palette so a source:"user" pick can't bypass the D1 confirm.
    palette: { mode: "hidden" },
    argsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const target = resolveTarget(args, ctx);
      await window.electron.devPreview.reinstallAndRestart(target);
    },
  }));
}

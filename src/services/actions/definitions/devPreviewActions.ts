import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { usePortalStore } from "@/store/portalStore";
import { isDevPreviewPanel } from "@shared/types/panel";
import { buildDevPreviewPartition } from "@shared/utils/partitionUtils";
import { logError } from "@/utils/logger";
import { getPortalBoundsWithRetry, showPortalTabIfNoOverlay } from "./portalHelpers";

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
      "Reload the dev preview's page without restarting the underlying dev server. Try this first when the preview looks stale — it is fast and keeps the server warm. Restart the server instead when the process itself is wedged or its configuration changed.",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
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
      "Stop the dev server and start it again, keeping caches and installed dependencies. Anything in flight is interrupted and the preview is unavailable until it comes back, which is slower than simply reloading the page. Reload first unless the server process itself is the problem.",
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

  actions.set("devPreview.promoteToPortal", () => ({
    id: "devPreview.promoteToPortal",
    title: "Open in Web",
    description:
      "Open the current dev preview URL in a Web tab, sharing the same session (cookies, localStorage, IndexedDB). The dev preview stays open; sessionStorage does not carry over.",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["portal", "promote", "browser", "preview", "session"],
    palette: {
      mode: "requireContext",
      // resolveTarget() needs a focused dev preview AND ctx.projectId.
      isReady: (ctx) => Boolean(ctx.projectId) && isDevPreviewFocused(),
      reason: "Focus a dev preview to open it in Web",
    },
    argsSchema,
    run: async (args: unknown, ctx: ActionContext) => {
      const { panelId, projectId } = resolveTarget(args, ctx);
      const panel = usePanelStore.getState().getTerminal(panelId);
      if (!panel || !isDevPreviewPanel(panel)) {
        throw new Error("Focused panel is not a dev preview");
      }

      const url = panel.browserUrl?.trim() || panel.devServerUrl?.trim();
      if (!url) {
        // Nothing has loaded yet — no-op rather than opening a blank tab.
        return;
      }

      const partition = buildDevPreviewPartition(projectId, panel.worktreeId, panelId);
      const title = panel.title?.trim() || "Dev preview";
      const tabId = `tab-${crypto.randomUUID()}`;

      const portal = usePortalStore.getState();
      if (!portal.isOpen) {
        portal.setOpen(true);
      }

      const bounds = await getPortalBoundsWithRetry();
      try {
        // Create the WebContentsView on the dev-preview partition BEFORE the tab
        // becomes active. PortalVisibilityController auto-creates any active,
        // not-yet-created tab via a partition-less portal.create; pre-creating
        // here (and marking it created) makes that path a no-op so the shared
        // session isn't lost to a racing default-partition view (#9102).
        await window.electron.portal.create({ tabId, url, partition });
        const store = usePortalStore.getState();
        store.markTabCreated(tabId);
        usePortalStore.setState((s) => ({
          tabs: [...s.tabs, { id: tabId, url, title, partition }],
          activeTabId: tabId,
        }));
        if (bounds) {
          await showPortalTabIfNoOverlay(tabId, bounds);
        }
      } catch (error) {
        logError("Failed to promote dev preview to portal", error);
        // Roll the half-created tab back, then rethrow: swallowing here made
        // dispatch() resolve {ok:true} on a failed promotion, so the caller had
        // nothing to surface and the user saw nothing at all (#11114).
        usePortalStore.getState().closeTab(tabId);
        throw error;
      }
    },
  }));
}

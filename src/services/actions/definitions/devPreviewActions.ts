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

  actions.set("devPreview.promoteToPortal", () => ({
    id: "devPreview.promoteToPortal",
    title: "Open in Portal",
    description:
      "Open the current dev preview URL in a Portal tab, sharing the same session (cookies, localStorage, IndexedDB). The dev preview stays open; sessionStorage does not carry over.",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["portal", "promote", "browser", "preview", "session"],
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
        usePortalStore.getState().closeTab(tabId);
      }
    },
  }));
}

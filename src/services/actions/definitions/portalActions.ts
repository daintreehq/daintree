import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { PORTAL_DEFAULT_WIDTH } from "@shared/types";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { usePortalStore } from "@/store/portalStore";
import { useUIStore } from "@/store/uiStore";
import { logError } from "@/utils/logger";
import { deriveEffectiveTier } from "../deriveEffectiveTier";
import { usePortalPendingCloseStore } from "@/store/portalPendingCloseStore";
import { PortalTabSummarySchema } from "./schemas";
import {
  activatePortalTab,
  clearPortalPendingIf,
  getPortalBounds,
  parseConfirmed,
  showPortalTabIfNoOverlay,
} from "./portalHelpers";

export function registerPortalActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("portal.toggle", () => ({
    id: "portal.toggle",
    title: "Toggle Portal",
    description:
      "Show or hide the portal browser panel, whichever it currently is not. This changes what the user sees without closing any tab or discarding page state. Because it toggles rather than sets, calling it without knowing the current state can hide a panel the user is using.",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["web", "embed", "browser", "dock"],
    run: async () => {
      usePortalStore.getState().toggle();
    },
  }));

  actions.set("portal.listTabs", () => ({
    id: "portal.listTabs",
    title: "List Portal Tabs",
    description:
      "List the tabs currently open in the portal browser, with their addresses and titles. Use this to find a tab to act on. It never fails — an empty list means the portal has no tabs open rather than that it is unavailable.",
    category: "portal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      isOpen: z.boolean(),
      activeTabId: z.string().nullable(),
      tabs: z.array(PortalTabSummarySchema),
    }),
    run: async () => {
      const state = usePortalStore.getState();
      return {
        isOpen: state.isOpen,
        activeTabId: state.activeTabId,
        tabs: state.tabs.map((t) => ({
          id: t.id,
          url: t.url ?? null,
          title: t.title,
        })),
      };
    },
  }));

  actions.set("portal.links.add", () => ({
    id: "portal.links.add",
    title: "Add Portal Link",
    description: "Add a user link to the portal",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      title: z.string().min(1),
      url: z.string().min(1),
      icon: z.string().optional().default("globe"),
      alwaysEnabled: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      const { title, url, icon, alwaysEnabled } = args as {
        title: string;
        url: string;
        icon: string;
        alwaysEnabled?: boolean;
      };
      usePortalStore.getState().addLink({
        title,
        url,
        icon,
        type: "user",
        enabled: true,
        alwaysEnabled,
      });
    },
  }));

  actions.set("portal.links.remove", () => ({
    id: "portal.links.remove",
    title: "Remove Portal Link",
    description: "Remove a portal link by ID",
    category: "portal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale: "Permanently removes a portal link by ID. The link configuration is lost.",
    argsSchema: z.object({ id: z.string() }),
    run: async (args: unknown) => {
      const { id } = args as { id: string };
      usePortalStore.getState().removeLink(id);
    },
  }));

  actions.set("portal.links.update", () => ({
    id: "portal.links.update",
    title: "Update Portal Link",
    description: "Update a portal link",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      id: z.string(),
      updates: z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        icon: z.string().optional(),
        enabled: z.boolean().optional(),
        order: z.number().int().optional(),
      }),
    }),
    run: async (args: unknown) => {
      const { id, updates } = args as { id: string; updates: Record<string, unknown> };
      usePortalStore.getState().updateLink(id, updates as any);
    },
  }));

  actions.set("portal.links.toggle", () => ({
    id: "portal.links.toggle",
    title: "Toggle Portal Link",
    description: "Enable or disable a portal link",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ id: z.string() }),
    run: async (args: unknown) => {
      const { id } = args as { id: string };
      usePortalStore.getState().toggleLink(id);
    },
  }));

  actions.set("portal.links.reorder", () => ({
    id: "portal.links.reorder",
    title: "Reorder Portal Links",
    description: "Reorder portal links by index",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fromIndex: z.number().int().nonnegative(), toIndex: z.number().int() }),
    run: async (args: unknown) => {
      const { fromIndex, toIndex } = args as { fromIndex: number; toIndex: number };
      usePortalStore.getState().reorderLinks(fromIndex, toIndex);
    },
  }));

  actions.set("portal.tabs.reorder", () => ({
    id: "portal.tabs.reorder",
    title: "Reorder Portal Tabs",
    description: "Reorder portal tabs by index",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fromIndex: z.number().int().nonnegative(), toIndex: z.number().int() }),
    run: async (args: unknown) => {
      const { fromIndex, toIndex } = args as { fromIndex: number; toIndex: number };
      usePortalStore.getState().reorderTabs(fromIndex, toIndex);
    },
  }));

  actions.set("portal.newTab", () => ({
    id: "portal.newTab",
    title: "New Portal Tab",
    description:
      "Open a new empty tab in the portal browser for the user to work in. This adds a tab that consumes resources until closed. Open a specific address instead when the destination is already known.",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["create", "add", "blank", "open"],
    run: async () => {
      const state = usePortalStore.getState();

      if (state.defaultNewTabUrl) {
        const url = state.defaultNewTabUrl;
        const link = state.links.find((l) => l.url === url);
        const agentInfo = getAIAgentInfo(url);
        const title = link?.title ?? agentInfo?.title ?? "New Tab";
        const newTabId = state.createTab(url, title);
        if (agentInfo?.icon) {
          state.updateTabIcon(newTabId, agentInfo.icon);
        }
        await activatePortalTab(newTabId);
        return;
      }

      state.createBlankTab();
      await window.electron.portal.hide().catch(() => {});
    },
  }));

  actions.set("portal.openLaunchpad", () => ({
    id: "portal.openLaunchpad",
    title: "Open Portal Launchpad",
    description: "Open the portal launchpad (blank tab)",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["home", "blank", "start", "tab"],
    run: async () => {
      usePortalStore.getState().createBlankTab();
      await window.electron.portal.hide().catch(() => {});
    },
  }));

  actions.set("portal.closeAllTabs", () => ({
    id: "portal.closeAllTabs",
    title: "Close All Portal Tabs",
    description: "Close all portal tabs",
    category: "portal",
    kind: "command",
    danger: "safe",
    // Runtime-escalated to a D1 confirm at 3+ tabs. A confirmed dispatch
    // carries `{ confirmed: true }`; recording that into `lastAction` would
    // let `action.repeatLast` replay the close past its gate.
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["remove", "clear", "cleanup", "tabs"],
    argsSchema: z.object({ confirmed: z.boolean().optional() }).optional(),
    run: async (args: unknown) => {
      const tabs = usePortalStore.getState().tabs;
      if (
        !parseConfirmed(args) &&
        deriveEffectiveTier("portal.closeAllTabs", { tabCount: tabs.length }) === "D1"
      ) {
        usePortalPendingCloseStore.getState().request({
          kind: "closeAll",
          tabsToClose: [...tabs],
        });
        return;
      }
      clearPortalPendingIf("closeAll");
      usePortalStore.getState().closeAllTabs();
      await window.electron.portal.hide().catch(() => {});
    },
  }));

  actions.set("portal.openUrl", () => ({
    id: "portal.openUrl",
    title: "Open URL in Portal",
    description:
      "Open a web page in a new portal tab, adding to whatever tabs are already open. This creates a tab that consumes resources until closed, so reuse an existing tab when repeatedly visiting the same page. It shows the page to the user rather than returning its contents.",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      url: z.string(),
      title: z.string().optional(),
      background: z
        .boolean()
        .optional()
        .describe("If true, create tab without showing portal (default: false)"),
    }),
    run: async (args: unknown) => {
      const { url, title, background } = args as {
        url: string;
        title?: string;
        background?: boolean;
      };
      const state = usePortalStore.getState();
      const agentInfo = getAIAgentInfo(url);
      const finalTitle = title ?? agentInfo?.title ?? "New Tab";
      const icon = agentInfo?.icon;

      if (background) {
        const newTabId = `tab-${crypto.randomUUID()}`;
        usePortalStore.setState((s) => ({
          tabs: [...s.tabs, { id: newTabId, url, title: finalTitle, icon }],
        }));

        try {
          await window.electron.portal.create({ tabId: newTabId, url });
          state.markTabCreated(newTabId);
        } catch (error) {
          logError("Failed to create background portal tab", error);
          usePortalStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== newTabId),
          }));
        }
        return;
      }

      if (useUIStore.getState().overlayStack.length > 0) return;

      if (!state.isOpen) {
        state.setOpen(true);
      }

      const activeTabId = state.activeTabId;
      const activeTab = activeTabId ? state.tabs.find((t) => t.id === activeTabId) : null;

      let targetId: string;
      if (activeTabId && activeTab && !activeTab.url) {
        targetId = activeTabId;
        state.updateTabUrl(targetId, url);
        state.updateTabTitle(targetId, finalTitle);
        if (icon) state.updateTabIcon(targetId, icon);
      } else {
        targetId = state.createTab(url, finalTitle);
        if (icon) state.updateTabIcon(targetId, icon);
      }

      await activatePortalTab(targetId);
    },
  }));

  actions.set("portal.duplicateTab", () => ({
    id: "portal.duplicateTab",
    // Per-tab op: duplicates the active portal tab, no-op without one.
    // Portal-toolbar/context-menu affordance, not a global palette command.
    palette: { mode: "hidden" },
    title: "Duplicate Portal Tab",
    description: "Duplicate a portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (!tab?.url) return;

      const bounds = getPortalBounds();
      if (!bounds) return;

      const newTabId = state.duplicateTab(targetId);
      if (!newTabId) return;

      try {
        await window.electron.portal.create({ tabId: newTabId, url: tab.url });
        state.markTabCreated(newTabId);
        await showPortalTabIfNoOverlay(newTabId, bounds);
      } catch (error) {
        logError("Failed to duplicate portal tab", error);
        state.closeTab(newTabId);
      }
    },
  }));

  actions.set("portal.resetWidth", () => ({
    id: "portal.resetWidth",
    title: "Reset Portal Width",
    description: "Reset portal width to default",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["size", "default", "resize", "layout"],
    run: async () => {
      usePortalStore.getState().setWidth(PORTAL_DEFAULT_WIDTH);
    },
  }));

  actions.set("portal.width.set", () => ({
    id: "portal.width.set",
    title: "Set Portal Width",
    description: "Set portal width",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ width: z.number().int().positive() }),
    run: async (args: unknown) => {
      const { width } = args as { width: number };
      usePortalStore.getState().setWidth(width);
    },
  }));

  actions.set("portal.toggleDevDashboard", () => ({
    id: "portal.toggleDevDashboard",
    title: "Toggle Dev Server Dashboard",
    description:
      "Show or hide the dashboard that lists dev servers across every worktree. This changes what the user sees and starts or stops no server itself. Because it toggles rather than sets, calling it blind can hide a view the user is reading.",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dev", "server", "dashboard", "preview", "worktree", "ports"],
    run: async () => {
      usePortalStore.getState().toggleDevDashboard();
    },
  }));

  actions.set("portal.setDefaultNewTab", () => ({
    id: "portal.setDefaultNewTab",
    title: "Set Default New Tab",
    description: "Set the default new tab for portal",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string().nullable() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string | null };
      usePortalStore.getState().setDefaultNewTabUrl(url);
    },
  }));
}

import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { SidecarLayoutModeSchema } from "./schemas";
import { z } from "zod";
import { cliAvailabilityClient, systemClient } from "@/clients";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useSidecarStore } from "@/store/sidecarStore";

export function registerPanelActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  const getSidecarBounds = (): { x: number; y: number; width: number; height: number } | null => {
    if (typeof document === "undefined") return null;
    const placeholder = document.getElementById("sidecar-placeholder");
    if (!placeholder) return null;
    const rect = placeholder.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  const getSidecarBoundsWithRetry = async (
    maxAttempts: number = 20,
    delayMs: number = 50
  ): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    let bounds = getSidecarBounds();
    let attempts = 0;
    while (!bounds && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      bounds = getSidecarBounds();
      attempts++;
    }
    return bounds;
  };

  const activateSidecarTab = async (tabId: string): Promise<void> => {
    const state = useSidecarStore.getState();
    const tab = state.tabs.find((t) => t.id === tabId);
    state.setActiveTab(tabId);

    if (!tab?.url) {
      await window.electron.sidecar.hide().catch(() => {});
      return;
    }

    const bounds = await getSidecarBoundsWithRetry();
    if (!bounds) return;

    try {
      if (!state.createdTabs.has(tabId)) {
        await window.electron.sidecar.create({ tabId, url: tab.url });
        state.markTabCreated(tabId);
      }
      await window.electron.sidecar.show({ tabId, bounds });
    } catch (error) {
      console.error("Failed to activate sidecar tab:", error);
    }
  };

  actions.set("panel.toggleDock", () => ({
    id: "panel.toggleDock",
    title: "Toggle Terminal Dock",
    description: "Toggle the terminal dock visibility",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-terminal-dock"));
    },
  }));

  actions.set("panel.toggleDockAlt", () => ({
    id: "panel.toggleDockAlt",
    title: "Toggle Terminal Dock (Alt)",
    description: "Toggle the terminal dock visibility",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-terminal-dock"));
    },
  }));

  actions.set("panel.toggleDiagnostics", () => ({
    id: "panel.toggleDiagnostics",
    title: "Toggle Diagnostics",
    description: "Toggle the diagnostics panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().toggleDock();
    },
  }));

  actions.set("panel.diagnosticsLogs", () => ({
    id: "panel.diagnosticsLogs",
    title: "Show Logs",
    description: "Open diagnostics panel with logs tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("logs");
    },
  }));

  actions.set("panel.diagnosticsEvents", () => ({
    id: "panel.diagnosticsEvents",
    title: "Show Events",
    description: "Open diagnostics panel with events tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("events");
    },
  }));

  actions.set("panel.diagnosticsMessages", () => ({
    id: "panel.diagnosticsMessages",
    title: "Show Problems",
    description: "Open diagnostics panel with problems tab",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useDiagnosticsStore.getState().openDock("problems");
    },
  }));

  actions.set("panel.toggleSidecar", () => ({
    id: "panel.toggleSidecar",
    title: "Toggle Sidecar",
    description: "Toggle the sidecar panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("canopy:toggle-sidecar"));
    },
  }));

  actions.set("sidecar.toggle", () => ({
    id: "sidecar.toggle",
    title: "Toggle Sidecar",
    description: "Toggle the sidecar panel",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().toggle();
    },
  }));

  actions.set("sidecar.links.add", () => ({
    id: "sidecar.links.add",
    title: "Add Sidecar Link",
    description: "Add a user link to the sidecar",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      title: z.string().min(1),
      url: z.string().min(1),
      icon: z.string().optional().default("globe"),
      type: z.enum(["system", "discovered", "user"]).optional().default("user"),
      enabled: z.boolean().optional().default(true),
      cliDetector: z.string().optional(),
      alwaysEnabled: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      const { title, url, icon, type, enabled, cliDetector, alwaysEnabled } = args as {
        title: string;
        url: string;
        icon: string;
        type: "system" | "discovered" | "user";
        enabled: boolean;
        cliDetector?: string;
        alwaysEnabled?: boolean;
      };
      useSidecarStore.getState().addLink({
        title,
        url,
        icon,
        type,
        enabled,
        cliDetector,
        alwaysEnabled,
      });
    },
  }));

  actions.set("sidecar.links.remove", () => ({
    id: "sidecar.links.remove",
    title: "Remove Sidecar Link",
    description: "Remove a sidecar link by ID",
    category: "sidecar",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ id: z.string() }),
    run: async (args: unknown) => {
      const { id } = args as { id: string };
      useSidecarStore.getState().removeLink(id);
    },
  }));

  actions.set("sidecar.links.update", () => ({
    id: "sidecar.links.update",
    title: "Update Sidecar Link",
    description: "Update a sidecar link",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      id: z.string(),
      updates: z
        .object({
          title: z.string().optional(),
          url: z.string().optional(),
          icon: z.string().optional(),
          enabled: z.boolean().optional(),
          order: z.number().int().optional(),
          type: z.enum(["system", "discovered", "user"]).optional(),
        })
        .catchall(z.unknown()),
    }),
    run: async (args: unknown) => {
      const { id, updates } = args as { id: string; updates: Record<string, unknown> };
      useSidecarStore.getState().updateLink(id, updates as any);
    },
  }));

  actions.set("sidecar.links.toggle", () => ({
    id: "sidecar.links.toggle",
    title: "Toggle Sidecar Link",
    description: "Enable or disable a sidecar link",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ id: z.string() }),
    run: async (args: unknown) => {
      const { id } = args as { id: string };
      useSidecarStore.getState().toggleLink(id);
    },
  }));

  actions.set("sidecar.links.reorder", () => ({
    id: "sidecar.links.reorder",
    title: "Reorder Sidecar Links",
    description: "Reorder sidecar links by index",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fromIndex: z.number().int().nonnegative(), toIndex: z.number().int() }),
    run: async (args: unknown) => {
      const { fromIndex, toIndex } = args as { fromIndex: number; toIndex: number };
      useSidecarStore.getState().reorderLinks(fromIndex, toIndex);
    },
  }));

  actions.set("sidecar.tabs.reorder", () => ({
    id: "sidecar.tabs.reorder",
    title: "Reorder Sidecar Tabs",
    description: "Reorder sidecar tabs by index",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fromIndex: z.number().int().nonnegative(), toIndex: z.number().int() }),
    run: async (args: unknown) => {
      const { fromIndex, toIndex } = args as { fromIndex: number; toIndex: number };
      useSidecarStore.getState().reorderTabs(fromIndex, toIndex);
    },
  }));

  actions.set("sidecar.links.rescan", () => ({
    id: "sidecar.links.rescan",
    title: "Rescan Sidecar Links",
    description: "Rescan local CLI availability and update discovered links",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const availability = await cliAvailabilityClient.refresh();
      const state = useSidecarStore.getState();
      state.setDiscoveredLinks(availability);
      state.markDiscoveryComplete();
      return availability;
    },
  }));

  actions.set("sidecar.closeTab", () => ({
    id: "sidecar.closeTab",
    title: "Close Sidecar Tab",
    description: "Close the active sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (targetId) {
        state.closeTab(targetId);
      }
    },
  }));

  actions.set("sidecar.nextTab", () => ({
    id: "sidecar.nextTab",
    title: "Next Sidecar Tab",
    description: "Switch to next sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useSidecarStore.getState();
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const nextIndex = currentIndex < state.tabs.length - 1 ? currentIndex + 1 : 0;
      const nextTabId = state.tabs[nextIndex]?.id;
      if (!nextTabId) return;
      await activateSidecarTab(nextTabId);
    },
  }));

  actions.set("sidecar.prevTab", () => ({
    id: "sidecar.prevTab",
    title: "Previous Sidecar Tab",
    description: "Switch to previous sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useSidecarStore.getState();
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : state.tabs.length - 1;
      const prevTabId = state.tabs[prevIndex]?.id;
      if (!prevTabId) return;
      await activateSidecarTab(prevTabId);
    },
  }));

  actions.set("sidecar.newTab", () => ({
    id: "sidecar.newTab",
    title: "New Sidecar Tab",
    description: "Open a new sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = useSidecarStore.getState();

      if (state.defaultNewTabUrl) {
        const url = state.defaultNewTabUrl;
        const link = state.links.find((l) => l.url === url);
        const agentInfo = getAIAgentInfo(url);
        const title = link?.title ?? agentInfo?.title ?? "New Tab";
        const newTabId = state.createTab(url, title);
        if (agentInfo?.icon) {
          state.updateTabIcon(newTabId, agentInfo.icon);
        }
        await activateSidecarTab(newTabId);
        return;
      }

      state.createBlankTab();
      await window.electron.sidecar.hide().catch(() => {});
    },
  }));

  actions.set("sidecar.openLaunchpad", () => ({
    id: "sidecar.openLaunchpad",
    title: "Open Sidecar Launchpad",
    description: "Open the sidecar launchpad (blank tab)",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().createBlankTab();
      await window.electron.sidecar.hide().catch(() => {});
    },
  }));

  actions.set("sidecar.closeAllTabs", () => ({
    id: "sidecar.closeAllTabs",
    title: "Close All Sidecar Tabs",
    description: "Close all sidecar tabs",
    category: "sidecar",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      useSidecarStore.getState().closeAllTabs();
      await window.electron.sidecar.hide().catch(() => {});
    },
  }));

  actions.set("sidecar.activateTab", () => ({
    id: "sidecar.activateTab",
    title: "Activate Sidecar Tab",
    description: "Switch to a specific sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId: string };
      await activateSidecarTab(tabId);
    },
  }));

  actions.set("sidecar.openUrl", () => ({
    id: "sidecar.openUrl",
    title: "Open URL in Sidecar",
    description: "Open a URL in a new sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      url: z.string(),
      title: z.string().optional(),
      background: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      const { url, title, background } = args as {
        url: string;
        title?: string;
        background?: boolean;
      };
      const state = useSidecarStore.getState();
      const agentInfo = getAIAgentInfo(url);
      const finalTitle = title ?? agentInfo?.title ?? "New Tab";
      const icon = agentInfo?.icon;

      if (background) {
        const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        useSidecarStore.setState((s) => ({
          tabs: [...s.tabs, { id: newTabId, url, title: finalTitle, icon }],
        }));

        try {
          await window.electron.sidecar.create({ tabId: newTabId, url });
          state.markTabCreated(newTabId);
        } catch (error) {
          console.error("Failed to create background sidecar tab:", error);
          useSidecarStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== newTabId),
          }));
        }
        return;
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

      await activateSidecarTab(targetId);
    },
  }));

  actions.set("sidecar.goBack", () => ({
    id: "sidecar.goBack",
    title: "Sidecar Back",
    description: "Navigate back in the active sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return false;
      if (!state.createdTabs.has(targetId)) return false;
      return await window.electron.sidecar.goBack(targetId);
    },
  }));

  actions.set("sidecar.goForward", () => ({
    id: "sidecar.goForward",
    title: "Sidecar Forward",
    description: "Navigate forward in the active sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return false;
      if (!state.createdTabs.has(targetId)) return false;
      return await window.electron.sidecar.goForward(targetId);
    },
  }));

  actions.set("sidecar.reload", () => ({
    id: "sidecar.reload",
    title: "Reload Sidecar",
    description: "Reload the active sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      if (!state.createdTabs.has(targetId)) return;
      await window.electron.sidecar.reload(targetId);
    },
  }));

  actions.set("sidecar.copyUrl", () => ({
    id: "sidecar.copyUrl",
    title: "Copy Sidecar URL",
    description: "Copy the active sidecar tab URL to clipboard",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (!tab?.url) return;
      await navigator.clipboard.writeText(tab.url);
    },
  }));

  actions.set("sidecar.openExternal", () => ({
    id: "sidecar.openExternal",
    title: "Open Sidecar URL Externally",
    description: "Open the active sidecar tab URL in the system browser",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (!tab?.url) return;
      await systemClient.openExternal(tab.url);
    },
  }));

  actions.set("sidecar.duplicateTab", () => ({
    id: "sidecar.duplicateTab",
    title: "Duplicate Sidecar Tab",
    description: "Duplicate a sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (!tab?.url) return;

      const bounds = getSidecarBounds();
      if (!bounds) return;

      const newTabId = state.duplicateTab(targetId);
      if (!newTabId) return;

      try {
        await window.electron.sidecar.create({ tabId: newTabId, url: tab.url });
        state.markTabCreated(newTabId);
        await window.electron.sidecar.show({ tabId: newTabId, bounds });
      } catch (error) {
        console.error("Failed to duplicate sidecar tab:", error);
        state.closeTab(newTabId);
      }
    },
  }));

  actions.set("sidecar.reloadTab", () => ({
    id: "sidecar.reloadTab",
    title: "Reload Sidecar Tab",
    description: "Reload a sidecar tab",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      if (!state.createdTabs.has(targetId)) return;
      await window.electron.sidecar.reload(targetId);
    },
  }));

  actions.set("sidecar.copyTabUrl", () => ({
    id: "sidecar.copyTabUrl",
    title: "Copy Sidecar Tab URL",
    description: "Copy a sidecar tab URL to clipboard",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (tab?.url) {
        await navigator.clipboard.writeText(tab.url);
      }
    },
  }));

  actions.set("sidecar.openTabExternal", () => ({
    id: "sidecar.openTabExternal",
    title: "Open Sidecar Tab Externally",
    description: "Open a sidecar tab URL in the system browser",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (tab?.url) {
        await systemClient.openExternal(tab.url);
      }
    },
  }));

  actions.set("sidecar.closeOthers", () => ({
    id: "sidecar.closeOthers",
    title: "Close Other Sidecar Tabs",
    description: "Close all sidecar tabs except one",
    category: "sidecar",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      state.closeTabsExcept(targetId);
      const next = useSidecarStore.getState();
      if (!next.activeTabId) {
        await window.electron.sidecar.hide().catch(() => {});
        return;
      }
      await activateSidecarTab(next.activeTabId);
    },
  }));

  actions.set("sidecar.closeToRight", () => ({
    id: "sidecar.closeToRight",
    title: "Close Tabs to the Right",
    description: "Close all sidecar tabs to the right of a tab",
    category: "sidecar",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = useSidecarStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      state.closeTabsAfter(targetId);
      const next = useSidecarStore.getState();
      if (!next.activeTabId) {
        await window.electron.sidecar.hide().catch(() => {});
        return;
      }
      await activateSidecarTab(next.activeTabId);
    },
  }));

  actions.set("sidecar.setLayoutMode", () => ({
    id: "sidecar.setLayoutMode",
    title: "Set Sidecar Layout Mode",
    description: "Set sidecar layout mode preference",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ mode: SidecarLayoutModeSchema }),
    run: async (args: unknown) => {
      const { mode } = args as { mode: "auto" | "push" | "overlay" };
      useSidecarStore.getState().setLayoutModePreference(mode);
    },
  }));

  actions.set("sidecar.resetWidth", () => ({
    id: "sidecar.resetWidth",
    title: "Reset Sidecar Width",
    description: "Reset sidecar width to default",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const { SIDECAR_DEFAULT_WIDTH } = await import("@shared/types");
      useSidecarStore.getState().setWidth(SIDECAR_DEFAULT_WIDTH);
    },
  }));

  actions.set("sidecar.width.set", () => ({
    id: "sidecar.width.set",
    title: "Set Sidecar Width",
    description: "Set sidecar width",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ width: z.number().int().positive() }),
    run: async (args: unknown) => {
      const { width } = args as { width: number };
      useSidecarStore.getState().setWidth(width);
    },
  }));

  actions.set("sidecar.setDefaultNewTab", () => ({
    id: "sidecar.setDefaultNewTab",
    title: "Set Default New Tab",
    description: "Set the default new tab for sidecar",
    category: "sidecar",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string().nullable() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string | null };
      useSidecarStore.getState().setDefaultNewTabUrl(url);
    },
  }));
}

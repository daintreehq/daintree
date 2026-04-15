import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { systemClient } from "@/clients";
import { getAIAgentInfo } from "@/lib/aiAgentDetection";
import { getPortalPlaceholderBounds } from "@/lib/portalBounds";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { usePortalStore } from "@/store/portalStore";
import { usePanelStore } from "@/store/panelStore";

export function registerPanelActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  // Query action: list all panels with metadata
  actions.set("panel.list", () => ({
    id: "panel.list",
    title: "List Panels",
    description: "Get list of all panels with layout information",
    category: "panel",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        location: z.enum(["grid", "dock", "trash", "background"]).optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { worktreeId, location } = (args ?? {}) as {
        worktreeId?: string;
        location?: "grid" | "dock" | "trash" | "background";
      };
      const state = usePanelStore.getState();
      let panels = state.panelIds.map((id) => state.panelsById[id]).filter(Boolean);

      if (worktreeId) {
        panels = panels.filter((p) => p.worktreeId === worktreeId);
      }

      if (location) {
        panels = panels.filter((p) => p.location === location);
      } else {
        panels = panels.filter((p) => p.location !== "trash" && p.location !== "background");
      }

      const portalState = usePortalStore.getState();

      return {
        panels: panels.map((p) => ({
          id: p.id,
          kind: p.kind,
          type: p.type,
          worktreeId: p.worktreeId ?? null,
          title: p.title ?? null,
          location: p.location ?? "grid",
          agentId: p.agentId ?? null,
          agentState: p.agentState ?? null,
        })),
        dock: {
          panelCount: panels.filter((p) => p.location === "dock").length,
        },
        portal: {
          isOpen: portalState.isOpen,
          tabCount: portalState.tabs.length,
          activeTabId: portalState.activeTabId,
        },
        focusedPanelId: state.focusedId ?? null,
        maximizedPanelId: state.maximizedId ?? null,
      };
    },
  }));

  actions.set("panel.focus", () => ({
    id: "panel.focus",
    title: "Focus Panel",
    description: "Focus a specific panel by ID",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      panelId: z.string(),
    }),
    run: async (args: unknown) => {
      const { panelId } = args as { panelId: string };
      const terminalState = usePanelStore.getState();
      const found = terminalState.panelsById[panelId];
      const panel = found && found.location !== "trash" ? found : undefined;
      if (!panel) {
        throw new Error("Terminal panel no longer exists");
      }
      terminalState.activateTerminal(panelId);
    },
  }));

  actions.set("panel.palette", () => ({
    id: "panel.palette",
    title: "Panel Palette",
    description: "Open panel palette to create non-PTY panels",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenPanelPalette();
    },
  }));

  const getPortalBounds = () => getPortalPlaceholderBounds();

  const getPortalBoundsWithRetry = async (
    maxAttempts: number = 20,
    delayMs: number = 50
  ): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    let bounds = getPortalBounds();
    let attempts = 0;
    while (!bounds && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      bounds = getPortalBounds();
      attempts++;
    }
    return bounds;
  };

  const activatePortalTab = async (tabId: string): Promise<void> => {
    const state = usePortalStore.getState();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }

    state.setActiveTab(tabId);

    if (!tab?.url) {
      await window.electron.portal.hide().catch(() => {});
      return;
    }

    const bounds = await getPortalBoundsWithRetry();
    if (!bounds) return;

    try {
      if (!state.createdTabs.has(tabId)) {
        await window.electron.portal.create({ tabId, url: tab.url });
        state.markTabCreated(tabId);
      }
      await window.electron.portal.show({ tabId, bounds });
    } catch (error) {
      console.error("Failed to activate portal tab:", error);
    }
  };

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

  actions.set("panel.togglePortal", () => ({
    id: "panel.togglePortal",
    title: "Toggle Portal",
    description: "Toggle the portal panel",
    category: "panel",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:toggle-portal"));
    },
  }));

  actions.set("portal.toggle", () => ({
    id: "portal.toggle",
    title: "Toggle Portal",
    description: "Toggle the portal panel",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      usePortalStore.getState().toggle();
    },
  }));

  actions.set("portal.listTabs", () => ({
    id: "portal.listTabs",
    title: "List Portal Tabs",
    description: "List all portal tabs with their IDs, URLs, and titles",
    category: "portal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
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

  actions.set("portal.closeTab", () => ({
    id: "portal.closeTab",
    title: "Close Portal Tab",
    description: "Close the active portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().min(1).optional() }).optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId || state.activeTabId;
      if (targetId) {
        state.closeTab(targetId);
      }
    },
  }));

  actions.set("portal.nextTab", () => ({
    id: "portal.nextTab",
    title: "Next Portal Tab",
    description: "Switch to next portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePortalStore.getState();
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const nextIndex = currentIndex < state.tabs.length - 1 ? currentIndex + 1 : 0;
      const nextTabId = state.tabs[nextIndex]?.id;
      if (!nextTabId) return;
      await activatePortalTab(nextTabId);
    },
  }));

  actions.set("portal.prevTab", () => ({
    id: "portal.prevTab",
    title: "Previous Portal Tab",
    description: "Switch to previous portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePortalStore.getState();
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : state.tabs.length - 1;
      const prevTabId = state.tabs[prevIndex]?.id;
      if (!prevTabId) return;
      await activatePortalTab(prevTabId);
    },
  }));

  actions.set("portal.newTab", () => ({
    id: "portal.newTab",
    title: "New Portal Tab",
    description: "Open a new portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
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
    danger: "confirm",
    scope: "renderer",
    run: async () => {
      usePortalStore.getState().closeAllTabs();
      await window.electron.portal.hide().catch(() => {});
    },
  }));

  actions.set("portal.activateTab", () => ({
    id: "portal.activateTab",
    title: "Activate Portal Tab",
    description: "Switch to a specific portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId: string };
      await activatePortalTab(tabId);
    },
  }));

  actions.set("portal.openUrl", () => ({
    id: "portal.openUrl",
    title: "Open URL in Portal",
    description: "Open a URL in a new portal tab",
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
        const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        usePortalStore.setState((s) => ({
          tabs: [...s.tabs, { id: newTabId, url, title: finalTitle, icon }],
        }));

        try {
          await window.electron.portal.create({ tabId: newTabId, url });
          state.markTabCreated(newTabId);
        } catch (error) {
          console.error("Failed to create background portal tab:", error);
          usePortalStore.setState((s) => ({
            tabs: s.tabs.filter((t) => t.id !== newTabId),
          }));
        }
        return;
      }

      // Ensure portal is visible before activating a tab
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

  actions.set("portal.goBack", () => ({
    id: "portal.goBack",
    title: "Portal Back",
    description: "Navigate back in the active portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().min(1).optional() }).optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId || state.activeTabId;
      if (!targetId) return false;
      if (!state.createdTabs.has(targetId)) return false;
      return await window.electron.portal.goBack(targetId);
    },
  }));

  actions.set("portal.goForward", () => ({
    id: "portal.goForward",
    title: "Portal Forward",
    description: "Navigate forward in the active portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().min(1).optional() }).optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId || state.activeTabId;
      if (!targetId) return false;
      if (!state.createdTabs.has(targetId)) return false;
      return await window.electron.portal.goForward(targetId);
    },
  }));

  actions.set("portal.reload", () => ({
    id: "portal.reload",
    title: "Reload Portal",
    description: "Reload the active portal tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().min(1).optional() }).optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId || state.activeTabId;
      if (!targetId) return;
      if (!state.createdTabs.has(targetId)) return;
      await window.electron.portal.reload(targetId);
    },
  }));

  actions.set("portal.copyUrl", () => ({
    id: "portal.copyUrl",
    title: "Copy Portal URL",
    description: "Copy the active portal tab URL to clipboard",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().min(1).optional() }).optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId || state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (!tab?.url) return;
      await navigator.clipboard.writeText(tab.url);
    },
  }));

  actions.set("portal.openExternal", () => ({
    id: "portal.openExternal",
    title: "Open Portal URL Externally",
    description: "Open the active portal tab URL in the system browser",
    category: "portal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().min(1).optional() }).optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId || state.activeTabId;
      if (!targetId) return;
      const tab = state.tabs.find((t) => t.id === targetId);
      if (!tab?.url) return;
      await systemClient.openExternal(tab.url);
    },
  }));

  actions.set("portal.duplicateTab", () => ({
    id: "portal.duplicateTab",
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
        await window.electron.portal.show({ tabId: newTabId, bounds });
      } catch (error) {
        console.error("Failed to duplicate portal tab:", error);
        state.closeTab(newTabId);
      }
    },
  }));

  actions.set("portal.reloadTab", () => ({
    id: "portal.reloadTab",
    title: "Reload Portal Tab",
    description: "Reload a portal tab",
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
      if (!state.createdTabs.has(targetId)) return;
      await window.electron.portal.reload(targetId);
    },
  }));

  actions.set("portal.copyTabUrl", () => ({
    id: "portal.copyTabUrl",
    title: "Copy Portal Tab URL",
    description: "Copy a portal tab URL to clipboard",
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
      if (tab?.url) {
        await navigator.clipboard.writeText(tab.url);
      }
    },
  }));

  actions.set("portal.openTabExternal", () => ({
    id: "portal.openTabExternal",
    title: "Open Portal Tab Externally",
    description: "Open a portal tab URL in the system browser",
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
      if (tab?.url) {
        await systemClient.openExternal(tab.url);
      }
    },
  }));

  actions.set("portal.closeOthers", () => ({
    id: "portal.closeOthers",
    title: "Close Other Portal Tabs",
    description: "Close all portal tabs except one",
    category: "portal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      state.closeTabsExcept(targetId);
      const next = usePortalStore.getState();
      if (!next.activeTabId) {
        await window.electron.portal.hide().catch(() => {});
        return;
      }
      await activatePortalTab(next.activeTabId);
    },
  }));

  actions.set("portal.closeToRight", () => ({
    id: "portal.closeToRight",
    title: "Close Tabs to the Right",
    description: "Close all portal tabs to the right of a tab",
    category: "portal",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ tabId: z.string().optional() }),
    run: async (args: unknown) => {
      const { tabId } = args as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      state.closeTabsAfter(targetId);
      const next = usePortalStore.getState();
      if (!next.activeTabId) {
        await window.electron.portal.hide().catch(() => {});
        return;
      }
      await activatePortalTab(next.activeTabId);
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
    run: async () => {
      const { PORTAL_DEFAULT_WIDTH } = await import("@shared/types");
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

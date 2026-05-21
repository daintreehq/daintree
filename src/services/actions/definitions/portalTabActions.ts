import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { systemClient } from "@/clients";
import { usePortalStore } from "@/store/portalStore";
import { usePortalPendingCloseStore } from "@/store/portalPendingCloseStore";
import { deriveEffectiveTier } from "../deriveEffectiveTier";
import { activatePortalTab, clearPortalPendingIf, parseConfirmed } from "./portalHelpers";

export function registerPortalTabActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
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
    keywords: ["cycle", "forward", "advance", "switch"],
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
    keywords: ["cycle", "back", "switch", "last"],
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
    danger: "safe",
    // Runtime-escalated to a D1 confirm when 3+ tabs would close. A confirmed
    // dispatch carries `{ confirmed: true }`; recording that into
    // `lastAction` would let `action.repeatLast` replay it past its gate.
    nonRepeatable: true,
    scope: "renderer",
    argsSchema: z
      .object({ tabId: z.string().optional(), confirmed: z.boolean().optional() })
      .optional(),
    run: async (args: unknown) => {
      const { tabId } = (args ?? {}) as { tabId?: string };
      const state = usePortalStore.getState();
      const targetId = tabId ?? state.activeTabId;
      if (!targetId) return;
      const tabsToClose = state.tabs.filter((t) => t.id !== targetId);
      if (
        !parseConfirmed(args) &&
        deriveEffectiveTier("portal.closeOthers", { tabCount: tabsToClose.length }) === "D1"
      ) {
        usePortalPendingCloseStore.getState().request({
          kind: "closeOthers",
          tabsToClose,
          keepTabId: targetId,
        });
        return;
      }
      clearPortalPendingIf("closeOthers");
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
    danger: "safe",
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
}

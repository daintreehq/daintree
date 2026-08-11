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
    // Per-tab portal ops act on the active portal tab and no-op when the portal
    // is closed/empty — portal-toolbar/keybinding/context-menu affordances, not
    // global palette commands. (Portal-level commands like portal.toggle /
    // portal.newTab / portal.openLaunchpad stay visible.)
    palette: { mode: "hidden" },
    title: "Close Web Tab",
    description: "Close the active Web tab",
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
    palette: { mode: "hidden" },
    title: "Next Web Tab",
    description: "Switch to the next Web tab",
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
    palette: { mode: "hidden" },
    title: "Previous Web Tab",
    description: "Switch to the previous Web tab",
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
    title: "Activate Web Tab",
    description: "Switch to a specific Web tab",
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
    palette: { mode: "hidden" },
    title: "Web Back",
    description: "Navigate back in the active Web tab",
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
    palette: { mode: "hidden" },
    title: "Web Forward",
    description: "Navigate forward in the active Web tab",
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
    palette: { mode: "hidden" },
    title: "Reload Web",
    description: "Reload the active Web tab",
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
    palette: { mode: "hidden" },
    title: "Copy Web URL",
    description: "Copy the active Web tab URL to clipboard",
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
    palette: { mode: "hidden" },
    title: "Open Web URL Externally",
    description: "Open the active Web tab URL in the system browser",
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
    palette: { mode: "hidden" },
    title: "Reload Web Tab",
    description: "Reload a Web tab",
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
    palette: { mode: "hidden" },
    title: "Copy Web Tab URL",
    description: "Copy a Web tab URL to clipboard",
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
    palette: { mode: "hidden" },
    title: "Open Web Tab Externally",
    description: "Open a Web tab URL in the system browser",
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
    palette: { mode: "hidden" },
    title: "Close Other Web Tabs",
    description: "Close all Web tabs except one",
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
    palette: { mode: "hidden" },
    title: "Close Tabs to the Right",
    description: "Close all Web tabs to the right of a tab",
    category: "portal",
    kind: "command",
    danger: "safe",
    // Runtime-escalated to a D1 confirm when 3+ tabs would close. A confirmed
    // dispatch carries `{ confirmed: true }`; recording that into `lastAction`
    // would let `action.repeatLast` replay it past its gate.
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
      const index = state.tabs.findIndex((t) => t.id === targetId);
      if (index === -1) return;
      const tabsToClose = state.tabs.slice(index + 1);
      if (tabsToClose.length === 0) return;
      if (
        !parseConfirmed(args) &&
        deriveEffectiveTier("portal.closeToRight", { tabCount: tabsToClose.length }) === "D1"
      ) {
        usePortalPendingCloseStore.getState().request({
          kind: "closeToRight",
          tabsToClose,
          keepTabId: targetId,
        });
        return;
      }
      clearPortalPendingIf("closeToRight");
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

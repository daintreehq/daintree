import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import type { PortalTab, PortalLink } from "@shared/types";
import { getPortalPlaceholderBounds } from "@/lib/portalBounds";
import {
  DEFAULT_PORTAL_TABS,
  PORTAL_MIN_WIDTH,
  PORTAL_MAX_WIDTH,
  PORTAL_DEFAULT_WIDTH,
  DEFAULT_SYSTEM_LINKS,
} from "@shared/types";
import { useUIStore } from "./uiStore";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

interface PortalState {
  isOpen: boolean;
  width: number;
  activeTabId: string | null;
  tabs: PortalTab[];
  createdTabs: Set<string>;
  links: PortalLink[];
  defaultNewTabUrl: string | null;
}

interface PortalActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setActiveTab: (id: string | null) => void;
  createTab: (url: string, title: string) => string;
  createBlankTab: () => string;
  closeTab: (id: string) => void;
  closeActiveTab: () => void;
  closeAllTabs: () => void;
  cycleNextTab: () => void;
  cyclePrevTab: () => void;
  duplicateTab: (id: string) => string | null;
  closeTabsExcept: (id: string) => void;
  closeTabsAfter: (id: string) => void;
  updateTabTitle: (id: string, title: string) => void;
  updateTabUrl: (id: string, url: string) => void;
  updateTabIcon: (id: string, icon: string | undefined) => void;
  markTabCreated: (id: string) => void;
  unmarkTabCreated: (id: string) => void;
  markTabsUncreated: (tabIds: string[]) => void;
  isTabCreated: (id: string) => boolean;
  reset: () => void;
  addLink: (link: Omit<PortalLink, "id" | "order">) => void;
  removeLink: (id: string) => void;
  updateLink: (id: string, updates: Partial<PortalLink>) => void;
  toggleLink: (id: string) => void;
  reorderLinks: (fromIndex: number, toIndex: number) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setDefaultNewTabUrl: (url: string | null) => void;
}

const initialState: PortalState = {
  isOpen: false,
  width: PORTAL_DEFAULT_WIDTH,
  activeTabId: null,
  tabs: DEFAULT_PORTAL_TABS,
  createdTabs: new Set<string>(),
  links: [...DEFAULT_SYSTEM_LINKS],
  defaultNewTabUrl: null,
};

const createPortalStore: StateCreator<PortalState & PortalActions> = (set, get) => {
  const CLOSE_TAB_RESTORE_MAX_ATTEMPTS = 20;
  const CLOSE_TAB_RESTORE_DELAY_MS = 50;

  const getPlaceholderBounds = () => getPortalPlaceholderBounds();

  const restoreActiveTabAfterClose = (tabId: string, attempt: number = 0) => {
    const state = get();
    if (!state.isOpen || state.activeTabId !== tabId) return;

    const activeTab = state.tabs.find((tab) => tab.id === tabId);
    if (!activeTab) return;
    if (!activeTab.url) {
      window.electron.portal.hide();
      return;
    }

    const bounds = getPlaceholderBounds();
    if (!bounds) {
      if (attempt < CLOSE_TAB_RESTORE_MAX_ATTEMPTS) {
        setTimeout(
          () => restoreActiveTabAfterClose(tabId, attempt + 1),
          CLOSE_TAB_RESTORE_DELAY_MS
        );
      }
      return;
    }

    window.electron.portal.show({ tabId, bounds });
  };

  return {
    ...initialState,

    toggle: () =>
      set((s) => {
        // Suppress the closed→open transition while another surface owns the
        // viewport (e.g. a settings dialog). Without this the store flips to
        // isOpen=true but PortalVisibilityController keeps the webview hidden,
        // leaving the Portal visually closed yet "open" per the store.
        if (!s.isOpen && useUIStore.getState().overlayClaims.size > 0) return s;
        return { isOpen: !s.isOpen };
      }),

    setOpen: (open) => set({ isOpen: open }),

    setWidth: (width) => {
      const validWidth = Math.min(Math.max(width, PORTAL_MIN_WIDTH), PORTAL_MAX_WIDTH);
      set({ width: validWidth });
    },

    setActiveTab: (id) => set({ activeTabId: id }),

    createTab: (url, title) => {
      const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newTab: PortalTab = { id: newTabId, url, title };
      set((s) => ({
        tabs: [...s.tabs, newTab],
        activeTabId: newTabId,
      }));
      return newTabId;
    },

    createBlankTab: () => {
      const state = get();
      const existingBlank = state.tabs.find((t) => !t.url);

      if (existingBlank) {
        set({ activeTabId: existingBlank.id });
        return existingBlank.id;
      }

      const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newTab: PortalTab = { id: newTabId, url: null, title: "New Tab" };
      set((s) => ({
        tabs: [...s.tabs, newTab],
        activeTabId: newTabId,
      }));
      return newTabId;
    },

    closeTab: (id) => {
      const state = get();
      const closingIndex = state.tabs.findIndex((t) => t.id === id);
      if (closingIndex === -1) return;

      const wasActive = id === state.activeTabId;
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (wasActive) {
        newActiveId =
          newTabs.length === 0 ? null : newTabs[Math.min(closingIndex, newTabs.length - 1)]!.id;
      }
      const nextCreatedTabs = new Set(state.createdTabs);
      nextCreatedTabs.delete(id);
      set({ tabs: newTabs, activeTabId: newActiveId, createdTabs: nextCreatedTabs });
      window.electron.portal.closeTab({ tabId: id });

      if (!wasActive) return;

      if (newActiveId) {
        const newActiveTab = newTabs.find((t) => t.id === newActiveId);
        if (newActiveTab && !newActiveTab.url) {
          window.electron.portal.hide();
        } else {
          setTimeout(() => {
            restoreActiveTabAfterClose(newActiveId);
          }, 0);
        }
      } else {
        window.electron.portal.hide();
      }
    },

    closeActiveTab: () => {
      const state = get();
      if (state.activeTabId) {
        get().closeTab(state.activeTabId);
      }
    },

    cycleNextTab: () => {
      const state = get();
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const nextIndex = currentIndex < state.tabs.length - 1 ? currentIndex + 1 : 0;
      set({ activeTabId: state.tabs[nextIndex]!.id });
    },

    cyclePrevTab: () => {
      const state = get();
      if (state.tabs.length <= 1) return;
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : state.tabs.length - 1;
      set({ activeTabId: state.tabs[prevIndex]!.id });
    },

    closeAllTabs: () => {
      const state = get();
      for (const tabId of state.createdTabs) {
        window.electron.portal.closeTab({ tabId });
      }
      set({ tabs: [], activeTabId: null, createdTabs: new Set<string>() });
    },

    duplicateTab: (id) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab?.url) return null;

      const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newTab: PortalTab = {
        id: newTabId,
        url: tab.url,
        title: tab.title,
        icon: tab.icon,
      };
      set((s) => ({
        tabs: [...s.tabs, newTab],
        activeTabId: newTabId,
      }));
      return newTabId;
    },

    closeTabsExcept: (id) => {
      const state = get();
      const keptTab = state.tabs.find((t) => t.id === id);
      if (!keptTab) return;
      const tabsToClose = state.tabs.filter((t) => t.id !== id);
      for (const tab of tabsToClose) {
        if (state.createdTabs.has(tab.id)) {
          window.electron.portal.closeTab({ tabId: tab.id });
        }
      }
      const nextCreatedTabs = new Set<string>();
      if (state.createdTabs.has(id)) nextCreatedTabs.add(id);
      set({ tabs: [keptTab], activeTabId: id, createdTabs: nextCreatedTabs });
    },

    closeTabsAfter: (id) => {
      const state = get();
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return;

      const tabsToClose = state.tabs.slice(index + 1);
      if (tabsToClose.length === 0) return;
      for (const tab of tabsToClose) {
        if (state.createdTabs.has(tab.id)) {
          window.electron.portal.closeTab({ tabId: tab.id });
        }
      }
      const remainingTabs = state.tabs.slice(0, index + 1);
      const newActiveId = remainingTabs.find((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : (remainingTabs[remainingTabs.length - 1]?.id ?? null);
      const nextCreatedTabs = new Set(
        [...state.createdTabs].filter((tabId) => remainingTabs.some((t) => t.id === tabId))
      );
      set({ tabs: remainingTabs, activeTabId: newActiveId, createdTabs: nextCreatedTabs });
    },

    updateTabTitle: (id, title) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
      })),

    updateTabUrl: (id, url) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, url } : t)),
      })),

    updateTabIcon: (id, icon) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, icon } : t)),
      })),

    markTabCreated: (id) =>
      set((s) => {
        const newSet = new Set(s.createdTabs);
        newSet.add(id);
        return { createdTabs: newSet };
      }),

    unmarkTabCreated: (id) =>
      set((s) => {
        const newSet = new Set(s.createdTabs);
        newSet.delete(id);
        return { createdTabs: newSet };
      }),

    markTabsUncreated: (tabIds) =>
      set((s) => {
        const newSet = new Set(s.createdTabs);
        for (const id of tabIds) newSet.delete(id);
        return { createdTabs: newSet };
      }),

    isTabCreated: (id) => get().createdTabs.has(id),

    reset: () =>
      set({
        ...initialState,
        createdTabs: new Set<string>(),
      }),

    addLink: (link) =>
      set((s) => {
        const maxOrder = s.links.reduce((max, l) => Math.max(max, l.order), -1);
        return {
          links: [
            ...s.links,
            {
              ...link,
              id: `user-${Date.now()}`,
              type: "user",
              enabled: true,
              order: maxOrder + 1,
            },
          ],
        };
      }),

    removeLink: (id) =>
      set((s) => {
        const filtered = s.links.filter((l) => l.id !== id);
        return {
          links: filtered.map((l, i) => ({ ...l, order: i })),
        };
      }),

    updateLink: (id, updates) =>
      set((s) => ({
        links: s.links.map((l) => (l.id === id ? { ...l, ...updates } : l)),
      })),

    toggleLink: (id) =>
      set((s) => ({
        links: s.links.map((l) =>
          l.id === id && !l.alwaysEnabled ? { ...l, enabled: !l.enabled } : l
        ),
      })),

    reorderLinks: (fromIndex, toIndex) =>
      set((s) => {
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= s.links.length ||
          toIndex >= s.links.length
        ) {
          return s;
        }
        const links = [...s.links];
        const [moved] = links.splice(fromIndex, 1);
        if (!moved) return s;
        links.splice(toIndex, 0, moved);
        return { links: links.map((l, i) => ({ ...l, order: i })) };
      }),

    reorderTabs: (fromIndex, toIndex) =>
      set((s) => {
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= s.tabs.length ||
          toIndex >= s.tabs.length
        ) {
          return s;
        }
        const newTabs = [...s.tabs];
        const [moved] = newTabs.splice(fromIndex, 1);
        if (!moved) return s;
        newTabs.splice(toIndex, 0, moved);
        return { tabs: newTabs };
      }),

    setDefaultNewTabUrl: (url) => {
      if (url === null) {
        set({ defaultNewTabUrl: null });
        return;
      }
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          console.warn("Invalid protocol for default URL, ignoring:", url);
          return;
        }
        set({ defaultNewTabUrl: url.trim() });
      } catch {
        console.warn("Invalid URL for default new tab, ignoring:", url);
      }
    },
  };
};

const portalStoreCreator: StateCreator<
  PortalState & PortalActions,
  [],
  [["zustand/persist", Partial<PortalState>]]
> = persist(createPortalStore, {
  name: "portal-storage",
  storage: createSafeJSONStorage(),
  partialize: (state) => ({
    links: state.links,
    width: state.width,
    tabs: state.tabs,
    defaultNewTabUrl: state.defaultNewTabUrl,
  }),
  merge: (persistedState: unknown, currentState) => {
    const persisted = persistedState as Partial<PortalState>;

    let links = currentState.links;
    if (Array.isArray(persisted.links)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawLinks = persisted.links as Array<Record<string, any>>;

      // Migrate discovered links to system: rename IDs and reclassify type.
      // Deduplicate so discovered-X and system-X don't both survive as system-X.
      const seen = new Set<string>();
      const migratedLinks: Array<Record<string, unknown>> = [];
      for (const l of rawLinks) {
        const newId = l.id?.startsWith("discovered-")
          ? String(l.id).replace("discovered-", "system-")
          : l.id;
        const newType = l.type === "discovered" ? "system" : l.type;
        if (seen.has(newId)) continue;
        seen.add(newId);
        migratedLinks.push({ ...l, id: newId, type: newType });
      }

      const userLinks = migratedLinks.filter((l) => l.type === "user");
      const persistedSystemById = new Map(
        migratedLinks.filter((l) => l.type === "system").map((l) => [l.id, l])
      );

      // Build final system links ordered per DEFAULT_SYSTEM_LINKS, merging persisted overrides.
      // Any persisted system links not in defaults are appended (custom system links).
      const defaultIds = new Set(DEFAULT_SYSTEM_LINKS.map((d) => d.id));
      const normalizedSystemLinks = DEFAULT_SYSTEM_LINKS.map((d) => ({
        ...d,
        ...(persistedSystemById.get(d.id) ?? {}),
        id: d.id,
        type: "system" as const,
      }));
      const extraSystemLinks = migratedLinks.filter(
        (l) => l.type === "system" && !defaultIds.has(l.id as string)
      );

      let order = 0;
      links = [
        ...normalizedSystemLinks.map((l) => ({ ...l, order: order++ })),
        ...extraSystemLinks.map((l) => ({ ...l, order: order++ })),
        ...userLinks.map((l) => ({ ...l, order: order++ })),
      ] as PortalLink[];
    }

    return {
      ...currentState,
      ...persisted,
      links,
      width:
        typeof persisted.width === "number"
          ? Math.min(Math.max(persisted.width, PORTAL_MIN_WIDTH), PORTAL_MAX_WIDTH)
          : currentState.width,
      defaultNewTabUrl:
        typeof persisted.defaultNewTabUrl === "string" && persisted.defaultNewTabUrl.trim()
          ? persisted.defaultNewTabUrl.trim()
          : null,
    };
  },
});

export const usePortalStore = create<PortalState & PortalActions>()(portalStoreCreator);

registerPersistedStore({
  storeId: "portalStore",
  store: usePortalStore,
  persistedStateType: "Partial<PortalState> (links, width, tabs, defaultNewTabUrl)",
});

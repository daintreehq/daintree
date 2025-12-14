import { create, type StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  SidecarLayoutMode,
  SidecarLayoutModePreference,
  SidecarTab,
  SidecarLink,
  CliAvailability,
} from "@shared/types";
import {
  DEFAULT_SIDECAR_TABS,
  SIDECAR_MIN_WIDTH,
  SIDECAR_MAX_WIDTH,
  SIDECAR_DEFAULT_WIDTH,
  MIN_GRID_WIDTH,
  LINK_TEMPLATES,
} from "@shared/types";

interface SidecarState {
  isOpen: boolean;
  width: number;
  layoutMode: SidecarLayoutMode;
  layoutModePreference: SidecarLayoutModePreference;
  activeTabId: string | null;
  tabs: SidecarTab[];
  createdTabs: Set<string>;
  links: SidecarLink[];
  discoveryComplete: boolean;
  defaultNewTabUrl: string | null;
}

interface SidecarActions {
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
  updateLayoutMode: (windowWidth: number, sidebarWidth: number) => void;
  setLayoutModePreference: (preference: SidecarLayoutModePreference) => void;
  markTabCreated: (id: string) => void;
  isTabCreated: (id: string) => boolean;
  reset: () => void;
  addLink: (link: Omit<SidecarLink, "id" | "order">) => void;
  removeLink: (id: string) => void;
  updateLink: (id: string, updates: Partial<SidecarLink>) => void;
  toggleLink: (id: string) => void;
  reorderLinks: (fromIndex: number, toIndex: number) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setDiscoveredLinks: (cliAvailability: CliAvailability) => void;
  markDiscoveryComplete: () => void;
  initializeDefaultLinks: () => void;
  setDefaultNewTabUrl: (url: string | null) => void;
}

function createDefaultLinks(): SidecarLink[] {
  return [];
}

const initialState: SidecarState = {
  isOpen: false,
  width: SIDECAR_DEFAULT_WIDTH,
  layoutMode: "push",
  layoutModePreference: "auto",
  activeTabId: null,
  tabs: DEFAULT_SIDECAR_TABS,
  createdTabs: new Set<string>(),
  links: createDefaultLinks(),
  discoveryComplete: false,
  defaultNewTabUrl: null,
};

const createSidecarStore: StateCreator<SidecarState & SidecarActions> = (set, get) => ({
  ...initialState,

  toggle: () => set((s) => ({ isOpen: !s.isOpen })),

  setOpen: (open) => set({ isOpen: open }),

  setWidth: (width) => {
    const validWidth = Math.min(Math.max(width, SIDECAR_MIN_WIDTH), SIDECAR_MAX_WIDTH);
    set({ width: validWidth });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  createTab: (url, title) => {
    const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newTab: SidecarTab = { id: newTabId, url, title };
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
    const newTab: SidecarTab = { id: newTabId, url: null, title: "New Tab" };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTabId,
    }));
    return newTabId;
  },

  closeTab: (id) => {
    const state = get();
    const closingIndex = state.tabs.findIndex((t) => t.id === id);
    const wasActive = id === state.activeTabId;
    const newTabs = state.tabs.filter((t) => t.id !== id);
    let newActiveId = state.activeTabId;
    if (wasActive) {
      newActiveId =
        newTabs.length === 0 ? null : newTabs[Math.min(closingIndex, newTabs.length - 1)].id;
    }
    const nextCreatedTabs = new Set(state.createdTabs);
    nextCreatedTabs.delete(id);
    set({ tabs: newTabs, activeTabId: newActiveId, createdTabs: nextCreatedTabs });
    window.electron.sidecar.closeTab({ tabId: id });

    if (!wasActive) return;

    if (newActiveId) {
      const newActiveTab = newTabs.find((t) => t.id === newActiveId);
      if (newActiveTab && !newActiveTab.url) {
        window.electron.sidecar.hide();
      } else {
        setTimeout(() => {
          const placeholder = document.getElementById("sidecar-placeholder");
          if (placeholder) {
            const rect = placeholder.getBoundingClientRect();
            window.electron.sidecar.show({
              tabId: newActiveId,
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            });
          }
        }, 0);
      }
    } else {
      window.electron.sidecar.hide();
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
    set({ activeTabId: state.tabs[nextIndex].id });
  },

  cyclePrevTab: () => {
    const state = get();
    if (state.tabs.length <= 1) return;
    const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : state.tabs.length - 1;
    set({ activeTabId: state.tabs[prevIndex].id });
  },

  closeAllTabs: () => {
    const state = get();
    for (const tabId of state.createdTabs) {
      window.electron.sidecar.closeTab({ tabId });
    }
    set({ tabs: [], activeTabId: null, createdTabs: new Set<string>() });
  },

  duplicateTab: (id) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab?.url) return null;

    const newTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newTab: SidecarTab = {
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
        window.electron.sidecar.closeTab({ tabId: tab.id });
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
        window.electron.sidecar.closeTab({ tabId: tab.id });
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

  updateLayoutMode: (windowWidth, sidebarWidth) => {
    const { width, layoutModePreference } = get();

    if (layoutModePreference !== "auto") {
      set({ layoutMode: layoutModePreference });
      return;
    }

    const remainingSpace = windowWidth - sidebarWidth - width;
    set({ layoutMode: remainingSpace < MIN_GRID_WIDTH ? "overlay" : "push" });
  },

  setLayoutModePreference: (preference) => {
    set({
      layoutModePreference: preference,
      ...(preference !== "auto" ? { layoutMode: preference } : {}),
    });
  },

  markTabCreated: (id) =>
    set((s) => {
      const newSet = new Set(s.createdTabs);
      newSet.add(id);
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
      newTabs.splice(toIndex, 0, moved);
      return { tabs: newTabs };
    }),

  setDiscoveredLinks: (availability) =>
    set((s) => {
      const existingUserLinks = s.links
        .filter((l) => l.type === "user")
        .sort((a, b) => a.order - b.order);
      const existingDiscoveredLinks = s.links.filter((l) => l.type === "discovered");
      const findExisting = (id: string) => existingDiscoveredLinks.find((l) => l.id === id);

      const newLinks: SidecarLink[] = [];
      let order = 0;

      Object.entries(availability).forEach(([agentId, isAvailable]) => {
        if (!isAvailable) return;
        const template = LINK_TEMPLATES[agentId];
        if (!template) return;
        const id = `discovered-${agentId}`;
        const existing = findExisting(id);
        newLinks.push({
          id,
          ...template,
          title: existing?.title ?? template.title,
          url: existing?.url ?? template.url,
          type: "discovered",
          enabled: existing?.enabled ?? true,
          order: order++,
        });
      });

      const userLinks = existingUserLinks.map((l) => ({ ...l, order: order++ }));

      return { links: [...newLinks, ...userLinks] };
    }),

  markDiscoveryComplete: () => set({ discoveryComplete: true }),

  initializeDefaultLinks: () =>
    set((s) => {
      if (s.links.length === 0) {
        return { links: createDefaultLinks() };
      }
      return s;
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
});

const sidecarStoreCreator: StateCreator<
  SidecarState & SidecarActions,
  [],
  [["zustand/persist", Partial<SidecarState>]]
> = persist(createSidecarStore, {
  name: "sidecar-storage",
  storage: createJSONStorage(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof window !== "undefined" ? localStorage : (undefined as any);
  }),
  partialize: (state) => ({
    links: state.links,
    width: state.width,
    tabs: state.tabs,
    layoutModePreference: state.layoutModePreference,
    defaultNewTabUrl: state.defaultNewTabUrl,
  }),
  merge: (persistedState: unknown, currentState) => {
    const persisted = persistedState as Partial<SidecarState>;
    return {
      ...currentState,
      ...persisted,
      width:
        typeof persisted.width === "number"
          ? Math.min(Math.max(persisted.width, SIDECAR_MIN_WIDTH), SIDECAR_MAX_WIDTH)
          : currentState.width,
      layoutModePreference:
        persisted.layoutModePreference === "auto" ||
        persisted.layoutModePreference === "push" ||
        persisted.layoutModePreference === "overlay"
          ? persisted.layoutModePreference
          : currentState.layoutModePreference,
      defaultNewTabUrl:
        typeof persisted.defaultNewTabUrl === "string" && persisted.defaultNewTabUrl.trim()
          ? persisted.defaultNewTabUrl.trim()
          : null,
    };
  },
});

export const useSidecarStore = create<SidecarState & SidecarActions>()(sidecarStoreCreator);

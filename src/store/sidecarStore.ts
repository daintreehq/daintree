import { create, type StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SidecarLayoutMode, SidecarTab, SidecarLink, CliAvailability } from "@shared/types";
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
  activeTabId: string | null;
  tabs: SidecarTab[];
  createdTabs: Set<string>;
  links: SidecarLink[];
  discoveryComplete: boolean;
}

interface SidecarActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setActiveTab: (id: string | null) => void;
  createTab: (url: string, title: string) => string;
  createBlankTab: () => string;
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  updateTabTitle: (id: string, title: string) => void;
  updateTabUrl: (id: string, url: string) => void;
  updateTabIcon: (id: string, icon: string | undefined) => void;
  updateLayoutMode: (windowWidth: number, sidebarWidth: number) => void;
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
}

function createDefaultLinks(): SidecarLink[] {
  return [];
}

const initialState: SidecarState = {
  isOpen: false,
  width: SIDECAR_DEFAULT_WIDTH,
  layoutMode: "push",
  activeTabId: null,
  tabs: DEFAULT_SIDECAR_TABS,
  createdTabs: new Set<string>(),
  links: createDefaultLinks(),
  discoveryComplete: false,
};

const createSidecarStore: StateCreator<SidecarState & SidecarActions> = (set, get) => ({
  ...initialState,

  toggle: () =>
    set((s) => {
      const newOpen = !s.isOpen;
      if (newOpen && typeof window !== "undefined") {
        setTimeout(() => {
          const { updateLayoutMode } = get();
          const sidebarWidth = 350;
          updateLayoutMode(window.innerWidth, sidebarWidth);
        }, 0);
      }
      return { isOpen: newOpen };
    }),

  setOpen: (open) => {
    set({ isOpen: open });
    if (open && typeof window !== "undefined") {
      setTimeout(() => {
        const { updateLayoutMode } = get();
        const sidebarWidth = 350;
        updateLayoutMode(window.innerWidth, sidebarWidth);
      }, 0);
    }
  },

  setWidth: (width) => {
    const validWidth = Math.min(Math.max(width, SIDECAR_MIN_WIDTH), SIDECAR_MAX_WIDTH);
    set({ width: validWidth });
    if (typeof window !== "undefined") {
      setTimeout(() => {
        const { updateLayoutMode, isOpen } = get();
        if (isOpen) {
          const sidebarWidth = 350;
          updateLayoutMode(window.innerWidth, sidebarWidth);
        }
      }, 0);
    }
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
    const newTabs = state.tabs.filter((t) => t.id !== id);
    let newActiveId = state.activeTabId;
    if (id === state.activeTabId) {
      newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }
    set({ tabs: newTabs, activeTabId: newActiveId });
    window.electron.sidecar.closeTab({ tabId: id });

    if (newActiveId) {
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
    } else {
      window.electron.sidecar.hide();
    }
  },

  closeAllTabs: () => {
    const state = get();
    for (const tab of state.tabs) {
      window.electron.sidecar.closeTab({ tabId: tab.id });
    }
    set({ tabs: [], activeTabId: null, createdTabs: new Set<string>() });
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
    const { width, isOpen } = get();
    if (!isOpen) return;
    const remainingSpace = windowWidth - sidebarWidth - width;
    set({ layoutMode: remainingSpace < MIN_GRID_WIDTH ? "overlay" : "push" });
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

      if (availability.claude) {
        const id = "discovered-claude";
        const existing = findExisting(id);
        newLinks.push({
          id,
          ...LINK_TEMPLATES.claude,
          title: existing?.title ?? LINK_TEMPLATES.claude.title,
          url: existing?.url ?? LINK_TEMPLATES.claude.url,
          type: "discovered",
          enabled: existing?.enabled ?? true,
          order: order++,
        });
      }

      if (availability.gemini) {
        const id = "discovered-gemini";
        const existing = findExisting(id);
        newLinks.push({
          id,
          ...LINK_TEMPLATES.gemini,
          title: existing?.title ?? LINK_TEMPLATES.gemini.title,
          url: existing?.url ?? LINK_TEMPLATES.gemini.url,
          type: "discovered",
          enabled: existing?.enabled ?? true,
          order: order++,
        });
      }

      if (availability.codex) {
        const id = "discovered-chatgpt";
        const existing = findExisting(id);
        newLinks.push({
          id,
          ...LINK_TEMPLATES.chatgpt,
          title: existing?.title ?? LINK_TEMPLATES.chatgpt.title,
          url: existing?.url ?? LINK_TEMPLATES.chatgpt.url,
          type: "discovered",
          enabled: existing?.enabled ?? true,
          order: order++,
        });
      }

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
});

const sidecarStoreCreator: StateCreator<
  SidecarState & SidecarActions,
  [],
  [["zustand/persist", Partial<SidecarState>]]
> = persist(createSidecarStore, {
  name: "sidecar-storage",
  storage: createJSONStorage(() =>
    typeof window !== "undefined" ? localStorage : (undefined as any)
  ),
  partialize: (state) => ({
    links: state.links,
    width: state.width,
    tabs: state.tabs,
  }),
});

export const useSidecarStore = create<SidecarState & SidecarActions>()(sidecarStoreCreator);

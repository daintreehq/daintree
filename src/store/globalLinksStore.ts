import { create } from "zustand";
import { persist } from "zustand/middleware";
import { reinsert, type RemovedPosition } from "@/lib/undoToast";
import { createSafeJSONStorage, readLocalStorageItemSafely } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import {
  LEGACY_PORTAL_BACKUP_KEY,
  LEGACY_PORTAL_STORAGE_KEY,
  readLegacyUserLinks,
  sanitizeGlobalLink,
} from "./persistence/globalLinksMigration";

/**
 * Links a person added for every project on this machine (#17242), kept apart
 * from any surface that shows them so they outlive it.
 */
export const GLOBAL_LINKS_STORAGE_KEY = "daintree-global-links";

export interface GlobalLink {
  id: string;
  title: string;
  url: string;
  icon: string;
  enabled: boolean;
  order: number;
}

export type GlobalLinkUpdate = Partial<
  Pick<GlobalLink, "title" | "url" | "icon" | "enabled" | "order">
>;

interface GlobalLinksPersistedState {
  links: GlobalLink[];
}

interface GlobalLinksState extends GlobalLinksPersistedState {
  addLink: (link: { title: string; url: string; icon?: string }) => string;
  removeLink: (id: string) => void;
  /** Puts a removed link back where it was, id and all — the Undo for `removeLink`. */
  restoreLink: (link: GlobalLink, position: RemovedPosition) => void;
  updateLink: (id: string, updates: GlobalLinkUpdate) => void;
  toggleLink: (id: string) => void;
  reorderLinks: (fromIndex: number, toIndex: number) => void;
}

const PERSIST_VERSION = 0;

function numbered(links: readonly GlobalLink[]): GlobalLink[] {
  return links.map((link, order) => (link.order === order ? link : { ...link, order }));
}

/** A stored list made safe to render: valid entries only, unique ids, by `order`. */
function readLinks(persisted: unknown): GlobalLink[] | null {
  if (!persisted || typeof persisted !== "object" || !("links" in persisted)) return null;
  const { links } = persisted;
  if (!Array.isArray(links)) return null;
  const seen = new Set<string>();
  const clean: GlobalLink[] = [];
  for (const entry of links) {
    const link = sanitizeGlobalLink(entry);
    if (!link || seen.has(link.id)) continue;
    seen.add(link.id);
    const order = (entry as { order?: unknown }).order;
    clean.push({ ...link, order: typeof order === "number" ? order : clean.length });
  }
  return sortedByOrder(clean);
}

function sortedByOrder(links: GlobalLink[]): GlobalLink[] {
  return [...links].sort((a, b) => a.order - b.order);
}

function byId(links: readonly GlobalLink[]): Record<string, GlobalLink> {
  return Object.fromEntries(links.map((link) => [link.id, link]));
}

// Every project view writes this key from its own V8 context; merge by the
// writer's delta, link by link, so a stale view can't drop a link a sibling
// just added or bring back one it removed.
function mergeLinks({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<GlobalLinksPersistedState>) {
  const merged = mergeRecordByWriterDelta(
    byId(readLinks(baseline?.state) ?? []),
    byId(incoming.state.links),
    byId(readLinks(onDisk?.state) ?? [])
  );
  return { ...incoming, state: { links: sortedByOrder(Object.values(merged)) } };
}

const storage = createSafeJSONStorage<GlobalLinksPersistedState>({ mergeOnWrite: mergeLinks });

/**
 * Carries the links a person added to the Portal into this store, once: only
 * while the key has never been written, and writing it even when nothing came
 * over, so its presence is the record that the move happened. Returns what it
 * moved, or null when the move had already happened.
 */
export function migrateLegacyGlobalLinks(): GlobalLink[] | null {
  if (readLocalStorageItemSafely(GLOBAL_LINKS_STORAGE_KEY) !== null) return null;
  const links = readLegacyUserLinks(
    readLocalStorageItemSafely(LEGACY_PORTAL_STORAGE_KEY),
    readLocalStorageItemSafely(LEGACY_PORTAL_BACKUP_KEY)
  );
  storage.setItem(GLOBAL_LINKS_STORAGE_KEY, { state: { links }, version: PERSIST_VERSION });
  return links;
}

// Seeds memory too, so the links still show this session if storage refused the write.
const migratedLinks = migrateLegacyGlobalLinks() ?? [];

export const useGlobalLinksStore = create<GlobalLinksState>()(
  persist(
    (set) => ({
      links: migratedLinks,

      addLink: ({ title, url, icon }) => {
        const id = `user-${crypto.randomUUID()}`;
        set((s) => ({
          links: numbered([
            ...s.links,
            { id, title, url, icon: icon ?? "globe", enabled: true, order: s.links.length },
          ]),
        }));
        return id;
      },

      removeLink: (id) =>
        set((s) => {
          if (!s.links.some((l) => l.id === id)) return s;
          return { links: numbered(s.links.filter((l) => l.id !== id)) };
        }),

      restoreLink: (link, position) =>
        set((s) => {
          if (s.links.some((l) => l.id === link.id)) return s;
          return { links: numbered(reinsert(s.links, link, position)) };
        }),

      updateLink: (id, updates) =>
        set((s) => {
          if (!s.links.some((l) => l.id === id)) return s;
          const { title, url, icon, enabled, order } = updates;
          const patch: GlobalLinkUpdate = {};
          if (title !== undefined) patch.title = title;
          if (url !== undefined) patch.url = url;
          if (icon !== undefined) patch.icon = icon;
          if (enabled !== undefined) patch.enabled = enabled;
          if (order !== undefined) patch.order = order;
          return {
            links: sortedByOrder(s.links.map((l) => (l.id === id ? { ...l, ...patch } : l))),
          };
        }),

      toggleLink: (id) =>
        set((s) => {
          if (!s.links.some((l) => l.id === id)) return s;
          return { links: s.links.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)) };
        }),

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
          return { links: numbered(links) };
        }),
    }),
    {
      name: GLOBAL_LINKS_STORAGE_KEY,
      version: PERSIST_VERSION,
      storage,
      partialize: (s) => ({ links: s.links }),
      merge: (persisted, current) => {
        const links = readLinks(persisted);
        return links ? { ...current, links } : current;
      },
    }
  )
);

/** Whether `id` names one of the global links, rather than a link some other list keeps. */
export function hasGlobalLink(id: string): boolean {
  return useGlobalLinksStore.getState().links.some((l) => l.id === id);
}

// A persist store hydrates once per view, and a cached view would keep showing
// a link another view removed. Views share the storage partition, so the
// sibling's write arrives as a `storage` event.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== GLOBAL_LINKS_STORAGE_KEY) return;
    void useGlobalLinksStore.persist.rehydrate();
  });
}

registerPersistedStore({
  storeId: "globalLinksStore",
  store: useGlobalLinksStore,
  persistedStateType: "{ links: GlobalLink[] } (id, title, url, icon, enabled, order)",
});

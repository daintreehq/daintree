import { create } from "zustand";
import { persist } from "zustand/middleware";
import { reinsert, type RemovedPosition } from "@/lib/undoToast";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import {
  GLOBAL_LINKS_STORAGE_KEY,
  LEGACY_PORTAL_STORAGE_KEY,
  readLegacyUserLinks,
  sanitizeGlobalLink,
} from "./persistence/globalLinksMigration";

export { GLOBAL_LINKS_STORAGE_KEY };

export interface GlobalLink {
  id: string;
  title: string;
  url: string;
  icon: string;
  enabled: boolean;
  /**
   * Rank in the list, lowest first. Ranks are sparse: a change moves only the
   * link it touches, so a write merged link by link across views never reads
   * an untouched link as edited.
   */
  order: number;
  /** A link that can't be switched off. */
  alwaysEnabled?: true;
}

export type GlobalLinkUpdate = Partial<
  Pick<GlobalLink, "title" | "url" | "icon" | "enabled" | "order">
>;

interface GlobalLinksPersistedState {
  links: GlobalLink[];
}

interface GlobalLinksState extends GlobalLinksPersistedState {
  addLink: (link: { title: string; url: string; icon?: string; alwaysEnabled?: boolean }) => string;
  removeLink: (id: string) => void;
  /** Puts a removed link back where it was, id and all — the Undo for `removeLink`. */
  restoreLink: (link: GlobalLink, position: RemovedPosition) => void;
  updateLink: (id: string, updates: GlobalLinkUpdate) => void;
  toggleLink: (id: string) => void;
  reorderLinks: (fromIndex: number, toIndex: number) => void;
}

const PERSIST_VERSION = 0;

/** By rank, ties by id, so every view settles on the same order whichever wrote last. */
function sortedByOrder(links: readonly GlobalLink[]): GlobalLink[] {
  return [...links].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A rank between two neighbours in a sorted list, either of which may be missing. */
function rankBetween(before: GlobalLink | undefined, after: GlobalLink | undefined): number {
  if (before && after) return before.order + (after.order - before.order) / 2;
  if (before) return before.order + 1;
  if (after) return after.order - 1;
  return 0;
}

/**
 * Ranks the link at `index` between its neighbours, leaving every other link
 * as it was. When no rank fits strictly between them (tied neighbours, or a
 * gap too fine to halve), the whole list is renumbered in its current order.
 */
function rankAt(links: readonly GlobalLink[], index: number): GlobalLink[] {
  const link = links[index];
  if (!link) return [...links];
  const before = links[index - 1];
  const after = links[index + 1];
  const order = rankBetween(before, after);
  const fits =
    Number.isFinite(order) &&
    (before === undefined || order > before.order) &&
    (after === undefined || order < after.order);
  if (!fits) return links.map((l, i) => (l.order === i ? l : { ...l, order: i }));
  const next = [...links];
  next[index] = { ...link, order };
  return next;
}

/** A stored list made safe to render: valid entries only, unique ids, by rank. */
function readLinks(persisted: unknown): GlobalLink[] | null {
  if (!persisted || typeof persisted !== "object") return null;
  const stored: unknown = Reflect.get(persisted, "links");
  if (!Array.isArray(stored)) return null;
  const seen = new Set<string>();
  const clean: GlobalLink[] = [];
  for (const entry of stored) {
    const link = sanitizeGlobalLink(entry, clean.length);
    if (!link || seen.has(link.id)) continue;
    seen.add(link.id);
    clean.push(link);
  }
  return sortedByOrder(clean);
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

/** Whether `key` holds a value; null when storage couldn't be read. */
function isStored(key: string): boolean | null {
  try {
    // storage-key: daintree-global-links portal-storage
    return globalThis.localStorage.getItem(key) !== null;
  } catch {
    return null;
  }
}

/**
 * Carries the links a person added to the Portal into this store, once: only
 * while the key has never been written, and writing it even when nothing came
 * over, so its presence is the record that the move happened. The Portal's
 * payload is read with the same backup recovery its own hydration has, and is
 * left in place. Returns what it moved, or null when there was nothing to do
 * or storage couldn't be read, which leaves the move for a later launch.
 */
export function migrateLegacyGlobalLinks(): GlobalLink[] | null {
  if (isStored(GLOBAL_LINKS_STORAGE_KEY) !== false) return null;
  // A read that failed is not an empty Portal list: leave the move for later.
  if (isStored(LEGACY_PORTAL_STORAGE_KEY) === null) return null;
  const legacy = createSafeJSONStorage<unknown>().getItem(LEGACY_PORTAL_STORAGE_KEY);
  const links = readLegacyUserLinks(legacy instanceof Promise ? null : legacy);
  storage.setItem(GLOBAL_LINKS_STORAGE_KEY, { state: { links }, version: PERSIST_VERSION });
  return links;
}

// Seeds memory too, so the links still show this session if storage refused the write.
const migratedLinks = migrateLegacyGlobalLinks() ?? [];

export const useGlobalLinksStore = create<GlobalLinksState>()(
  persist(
    (set) => ({
      links: migratedLinks,

      addLink: ({ title, url, icon, alwaysEnabled }) => {
        const id = `user-${crypto.randomUUID()}`;
        set((s) => {
          const links = [
            ...s.links,
            {
              id,
              title,
              url,
              icon: icon ?? "globe",
              enabled: true,
              order: 0,
              ...(alwaysEnabled ? { alwaysEnabled: true as const } : {}),
            },
          ];
          return { links: rankAt(links, links.length - 1) };
        });
        return id;
      },

      removeLink: (id) =>
        set((s) => {
          if (!s.links.some((l) => l.id === id)) return s;
          return { links: s.links.filter((l) => l.id !== id) };
        }),

      restoreLink: (link, position) =>
        set((s) => {
          if (s.links.some((l) => l.id === link.id)) return s;
          const links = reinsert(s.links, link, position);
          return {
            links: rankAt(
              links,
              links.findIndex((l) => l.id === link.id)
            ),
          };
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
          if (order !== undefined && Number.isFinite(order)) patch.order = order;
          return {
            links: sortedByOrder(s.links.map((l) => (l.id === id ? { ...l, ...patch } : l))),
          };
        }),

      toggleLink: (id) =>
        set((s) => {
          if (!s.links.some((l) => l.id === id && !l.alwaysEnabled)) return s;
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
          return { links: rankAt(links, toIndex) };
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
// sibling's write arrives as a `storage` event. The listener lives as long as
// the view's context, like the other cross-view stores'.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== GLOBAL_LINKS_STORAGE_KEY && event.key !== null) return;
    void useGlobalLinksStore.persist.rehydrate();
  });
}

registerPersistedStore({
  storeId: "globalLinksStore",
  store: useGlobalLinksStore,
  persistedStateType:
    "{ links: GlobalLink[] } (id, title, url, icon, enabled, order, alwaysEnabled?)",
});

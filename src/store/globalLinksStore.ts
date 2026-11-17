import { create } from "zustand";
import { persist } from "zustand/middleware";
import { reinsert, type RemovedPosition } from "@/lib/undoToast";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import {
  GLOBAL_LINKS_STORAGE_KEY,
  globalListOnDiskHolds,
  linksIn,
  readLegacyPortalPayload,
  readLegacyUserLinks,
  removeLegacyPortalPayload,
  sanitizeGlobalLink,
  type LegacyPortalPayload,
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

function byId(links: readonly GlobalLink[]): Map<string, GlobalLink> {
  return new Map(links.map((link) => [link.id, link]));
}

function contentChanged(before: GlobalLink, after: GlobalLink): boolean {
  return (
    before.title !== after.title ||
    before.url !== after.url ||
    before.icon !== after.icon ||
    before.enabled !== after.enabled ||
    before.alwaysEnabled !== after.alwaysEnabled
  );
}

/** One link both this writer and storage hold: each field this writer changed wins. */
function mergeLink(baseline: GlobalLink, incoming: GlobalLink, onDisk: GlobalLink): GlobalLink {
  const pick = <K extends keyof GlobalLink>(key: K) =>
    pickFieldByWriterDelta(baseline[key], incoming[key], onDisk[key]);
  return {
    id: incoming.id,
    title: pick("title"),
    url: pick("url"),
    icon: pick("icon"),
    enabled: pick("enabled"),
    order: pick("order"),
    ...(pick("alwaysEnabled") ? { alwaysEnabled: true as const } : {}),
  };
}

// Every project view writes this key from its own V8 context, so a write
// merges against what storage holds by the writer's delta, field by field: a
// stale view can't drop a link a sibling added, undo a sibling's edit or move
// with a field it never touched, or bring back a link a sibling removed by
// re-ranking it. Only an edit to a removed link's content brings it back.
function mergeLinks({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<GlobalLinksPersistedState>) {
  const known = byId(readLinks(baseline?.state) ?? []);
  const stored = byId(readLinks(onDisk?.state) ?? []);
  const merged: GlobalLink[] = [];
  const mine = new Set<string>();
  for (const link of incoming.state.links) {
    mine.add(link.id);
    const before = known.get(link.id);
    const current = stored.get(link.id);
    if (!before) merged.push(link);
    else if (current) merged.push(mergeLink(before, link, current));
    else if (contentChanged(before, link)) merged.push(link);
  }
  for (const link of stored.values()) {
    if (!mine.has(link.id) && !known.has(link.id)) merged.push(link);
  }
  return { ...incoming, state: { links: sortedByOrder(merged) } };
}

const storage = createSafeJSONStorage<GlobalLinksPersistedState>({ mergeOnWrite: mergeLinks });

/** Whether `key` holds a value; null when storage couldn't be read. */
function isStored(key: string): boolean | null {
  try {
    // storage-key: daintree-global-links
    return globalThis.localStorage.getItem(key) !== null;
  } catch {
    return null;
  }
}

/**
 * Removes the Portal's payload, which nothing else reads since the dock went
 * (#17256), once the global list on disk holds every link it kept. A payload
 * that couldn't be read stays, so does one holding no link list to check, and
 * so does one whose links the list lacks: a move that couldn't read it,
 * followed by an edit that wrote the list, must not cost the person the links
 * it never carried over.
 */
function retireLegacyPortalPayload(legacy: LegacyPortalPayload): void {
  if (legacy.kind !== "read" || !linksIn(legacy.envelope)) return;
  const links = readLegacyUserLinks(legacy.envelope);
  if (globalListOnDiskHolds(links, PERSIST_VERSION)) removeLegacyPortalPayload();
}

/**
 * Carries the links a person added to the Portal into this store, once: only
 * while the key has never been written, and writing it even when nothing came
 * over, so its presence is the record that the move happened. The Portal's
 * payload is removed once the list on disk holds its links, on the launch that
 * made the move or any later one. Returns what it moved, or null when there
 * was nothing to do or storage couldn't be read, which leaves the move for later.
 */
export function migrateLegacyGlobalLinks(): GlobalLink[] | null {
  const migrated = isStored(GLOBAL_LINKS_STORAGE_KEY);
  if (migrated === null) return null;
  const legacy = readLegacyPortalPayload();
  if (migrated) {
    retireLegacyPortalPayload(legacy);
    return null;
  }
  // A read that failed is not an empty Portal list: leave the move for later.
  if (legacy.kind === "unreadable") return null;
  const links = legacy.kind === "read" ? readLegacyUserLinks(legacy.envelope) : [];
  storage.setItem(GLOBAL_LINKS_STORAGE_KEY, { state: { links }, version: PERSIST_VERSION });
  // A write storage refused (quota, or the in-memory fallback) leaves the list
  // off disk, and with it the Portal's copy for a later launch.
  retireLegacyPortalPayload(legacy);
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

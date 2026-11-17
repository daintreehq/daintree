import type { GlobalLink } from "../globalLinksStore";
import { backupKeyFor, safeJSONParse } from "./safeStorage";

/**
 * Links a person added for every project on this machine (#17242), kept apart
 * from any surface that shows them so they outlive it.
 */
export const GLOBAL_LINKS_STORAGE_KEY = "daintree-global-links";

/**
 * Where global links lived before they had a store of their own (#17242): the
 * Portal dock's persisted state, beside its tabs, width and the built-in web
 * chats. Read raw, since the Portal store is gone (#17256), so a user who
 * upgrades straight past both releases still gets their links.
 */
export const LEGACY_PORTAL_STORAGE_KEY = "portal-storage";

const BUILT_IN_ID = /^(?:system|discovered)-/;

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

/**
 * One stored link as the global list keeps it, or null when it can't be one.
 * `order` is its stored rank when it has one, `fallbackOrder` otherwise.
 */
export function sanitizeGlobalLink(value: unknown, fallbackOrder: number): GlobalLink | null {
  if (!value || typeof value !== "object") return null;
  const id = field(value, "id");
  const url = field(value, "url");
  if (typeof id !== "string" || id === "") return null;
  if (typeof url !== "string" || url.trim() === "") return null;
  const title = field(value, "title");
  const icon = field(value, "icon");
  const enabled = field(value, "enabled");
  const order = field(value, "order");
  return {
    id,
    title: typeof title === "string" ? title : "",
    url,
    icon: typeof icon === "string" && icon !== "" ? icon : "globe",
    enabled: typeof enabled === "boolean" ? enabled : true,
    order: typeof order === "number" && Number.isFinite(order) ? order : fallbackOrder,
    ...(field(value, "alwaysEnabled") === true ? { alwaysEnabled: true as const } : {}),
  };
}

/**
 * The links a person added to the Portal, from its parsed persisted envelope
 * (versioned or not), in the order the Portal showed them after a launch: its
 * hydration numbered links by array position, whatever their stored `order`.
 * The built-in web chats stay behind.
 */
export function readLegacyUserLinks(envelope: unknown): GlobalLink[] {
  if (!envelope || typeof envelope !== "object") return [];
  const state = field(envelope, "state");
  if (!state || typeof state !== "object") return [];
  const stored = field(state, "links");
  if (!Array.isArray(stored)) return [];

  const seen = new Set<string>();
  const links: GlobalLink[] = [];
  for (const entry of stored) {
    if (!entry || typeof entry !== "object" || field(entry, "type") !== "user") continue;
    const link = sanitizeGlobalLink(entry, links.length);
    if (!link || BUILT_IN_ID.test(link.id) || seen.has(link.id)) continue;
    seen.add(link.id);
    links.push({ ...link, order: links.length });
  }
  return links;
}

/** What storage holds for the Portal's payload, read once so one answer decides the move. */
export type LegacyPortalPayload =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "read"; readonly envelope: unknown };

/**
 * The Portal's persisted envelope, or its last-good backup when the live copy
 * is corrupt or already gone. A read that throws is `unreadable`, never an
 * empty list: the move is then left for a later launch, with both copies kept.
 */
export function readLegacyPortalPayload(): LegacyPortalPayload {
  let live: string | null;
  let backup: string | null;
  try {
    const ls = globalThis.localStorage;
    // storage-key: portal-storage
    live = ls.getItem(LEGACY_PORTAL_STORAGE_KEY);
    // storage-key: portal-storage
    backup = ls.getItem(backupKeyFor(LEGACY_PORTAL_STORAGE_KEY));
  } catch {
    return { kind: "unreadable" };
  }
  if (live === null && backup === null) return { kind: "absent" };
  const context = { store: "globalLinksStore", key: LEGACY_PORTAL_STORAGE_KEY };
  const parsed = safeJSONParse<unknown>(live, context, undefined);
  if (parsed !== undefined) return { kind: "read", envelope: parsed };
  return { kind: "read", envelope: safeJSONParse<unknown>(backup, context, null) };
}

/**
 * Removes the Portal's payload and its backup. Called only once the global
 * list is on disk; a removal that fails is retried on the next launch.
 */
export function removeLegacyPortalPayload(): void {
  let ls: Storage;
  try {
    ls = globalThis.localStorage;
  } catch {
    return;
  }
  // storage-key: portal-storage
  for (const key of [LEGACY_PORTAL_STORAGE_KEY, backupKeyFor(LEGACY_PORTAL_STORAGE_KEY)]) {
    try {
      ls.removeItem(key);
    } catch {
      // Retried on the next launch, which finds the global list on disk.
    }
  }
}

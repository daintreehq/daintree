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

/** A key and its backup as real localStorage holds them, or null when a read throws. */
function readWithBackup(key: string): { live: string | null; backup: string | null } | null {
  try {
    const ls = globalThis.localStorage;
    // storage-key: portal-storage daintree-global-links
    const live = ls.getItem(key);
    // storage-key: portal-storage daintree-global-links
    const backup = ls.getItem(backupKeyFor(key));
    return { live, backup };
  } catch {
    return null;
  }
}

/** The `state.links` list an envelope holds, or null when it holds none. */
export function linksIn(envelope: unknown): unknown[] | null {
  if (!envelope || typeof envelope !== "object") return null;
  const state = field(envelope, "state");
  if (!state || typeof state !== "object") return null;
  const links = field(state, "links");
  return Array.isArray(links) ? links : null;
}

/**
 * The Portal's persisted envelope: its live copy when that holds a link list,
 * else its last-good backup when that does, which also covers a live copy
 * already gone. A read that throws is `unreadable`, never an empty list, so
 * the move waits for a later launch with both copies kept.
 */
export function readLegacyPortalPayload(): LegacyPortalPayload {
  const stored = readWithBackup(LEGACY_PORTAL_STORAGE_KEY);
  if (!stored) return { kind: "unreadable" };
  if (stored.live === null && stored.backup === null) return { kind: "absent" };
  const context = { store: "globalLinksStore", key: LEGACY_PORTAL_STORAGE_KEY };
  const live = safeJSONParse<unknown>(stored.live, context, null);
  if (linksIn(live)) return { kind: "read", envelope: live };
  const backup = safeJSONParse<unknown>(stored.backup, context, null);
  return { kind: "read", envelope: linksIn(backup) ? backup : live };
}

/**
 * Whether the global list on disk holds every one of `links`, read as its
 * hydration reads it: the live copy, or its backup when the live one is
 * corrupt, at the store's own `version`. False when it can't be read, holds no
 * list, or is at a version hydration would refuse, so the Portal's copy is
 * never let go for a list that doesn't carry its links.
 */
export function globalListOnDiskHolds(links: readonly GlobalLink[], version: number): boolean {
  const stored = readWithBackup(GLOBAL_LINKS_STORAGE_KEY);
  if (!stored || stored.live === null) return false;
  const context = { store: "globalLinksStore", key: GLOBAL_LINKS_STORAGE_KEY };
  const live = safeJSONParse<unknown>(stored.live, context, undefined);
  const envelope = live !== undefined ? live : safeJSONParse<unknown>(stored.backup, context, null);
  if (!envelope || typeof envelope !== "object") return false;
  // Hydration refuses only a numbered version other than its own.
  const storedVersion = field(envelope, "version");
  if (typeof storedVersion === "number" && storedVersion !== version) return false;
  const list = linksIn(envelope);
  if (!list) return false;
  const ids = new Set<string>();
  for (const entry of list) {
    const link = sanitizeGlobalLink(entry, 0);
    if (link) ids.add(link.id);
  }
  return links.every((link) => ids.has(link.id));
}

/**
 * Removes the Portal's payload and its backup. Called only once the global
 * list on disk holds the links it kept; a removal that fails is retried on the
 * next launch.
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
      // Retried on the next launch, which finds the links on disk again.
    }
  }
}

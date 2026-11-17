import type { GlobalLink } from "../globalLinksStore";
import { readLocalStorageItemSafely } from "./safeStorage";

/**
 * Links a person added for every project on this machine (#17242), kept apart
 * from any surface that shows them so they outlive it.
 */
export const GLOBAL_LINKS_STORAGE_KEY = "daintree-global-links";

/**
 * Where global links lived before they had a store of their own (#17242): the
 * Portal dock's persisted state, beside its tabs, width and the built-in web
 * chats. Read raw, never through the Portal store, so a user who upgrades past
 * the dock's removal still gets their links.
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

/**
 * The URLs of the person's own links as the global list last stored them, or
 * null while that list has never been written (or can't be read), when the
 * Portal's copy is still the person's list.
 */
export function readStoredGlobalLinkUrls(): string[] | null {
  const raw = readLocalStorageItemSafely(GLOBAL_LINKS_STORAGE_KEY);
  if (raw === null) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object") return null;
  const state = field(envelope, "state");
  if (!state || typeof state !== "object") return null;
  const stored = field(state, "links");
  if (!Array.isArray(stored)) return null;
  const urls: string[] = [];
  for (const entry of stored) {
    const link = sanitizeGlobalLink(entry, 0);
    if (link) urls.push(link.url);
  }
  return urls;
}

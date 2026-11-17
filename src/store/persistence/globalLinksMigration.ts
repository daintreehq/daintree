import type { GlobalLink } from "../globalLinksStore";

/**
 * Where global links lived before they had a store of their own (#17242): the
 * Portal dock's persisted state, beside its tabs, width and the built-in web
 * chats. Read raw, never through the Portal store, so a user who upgrades past
 * the dock's removal still gets their links.
 */
export const LEGACY_PORTAL_STORAGE_KEY = "portal-storage";
export const LEGACY_PORTAL_BACKUP_KEY = `${LEGACY_PORTAL_STORAGE_KEY}.__bak`;

const BUILT_IN_ID = /^(?:system|discovered)-/;
const CORRUPT = Symbol("corrupt");

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return CORRUPT;
  }
}

function storedLinks(envelope: unknown): unknown[] {
  if (!envelope || typeof envelope !== "object" || !("state" in envelope)) return [];
  const { state } = envelope;
  if (!state || typeof state !== "object" || !("links" in state)) return [];
  return Array.isArray(state.links) ? state.links : [];
}

/** One stored link as the global list keeps it, or null when it can't be one. */
export function sanitizeGlobalLink(value: unknown): Omit<GlobalLink, "order"> | null {
  if (!value || typeof value !== "object") return null;
  const { id, title, url, icon, enabled } = value as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof url !== "string" || url.trim() === "") return null;
  return {
    id,
    title: typeof title === "string" ? title : "",
    url,
    icon: typeof icon === "string" && icon !== "" ? icon : "globe",
    enabled: typeof enabled === "boolean" ? enabled : true,
  };
}

/**
 * The links a person added to the Portal, in the order the Portal showed them
 * after a launch (its hydration numbered links by array position, whatever
 * their stored `order`). Built-in web chats stay behind. A corrupt live payload
 * falls back to its backup copy, as the Portal's own hydration did.
 */
export function readLegacyUserLinks(primaryRaw: string | null, backupRaw: string | null) {
  let envelope = parse(primaryRaw);
  if (envelope === CORRUPT) envelope = parse(backupRaw);

  const seen = new Set<string>();
  const links: GlobalLink[] = [];
  for (const entry of storedLinks(envelope)) {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "user") {
      continue;
    }
    const link = sanitizeGlobalLink(entry);
    if (!link || BUILT_IN_ID.test(link.id) || seen.has(link.id)) continue;
    seen.add(link.id);
    links.push({ ...link, order: links.length });
  }
  return links;
}

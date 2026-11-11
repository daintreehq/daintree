/**
 * Configuration for the community plugin catalog (#16777, decision in
 * `docs/plugins/catalog.md`). Published beside the blocklist, fetched only
 * when something asks for it, and cached on disk so browsing works offline.
 */

/** Served from the same CDN as the blocklist and the update feeds. */
export const PLUGIN_CATALOG_URL = "https://updates.daintree.org/plugins/catalog.json";

/** On-disk cache filename under `app.getPath("userData")`. */
export const PLUGIN_CATALOG_CACHE_FILENAME = "plugin-catalog.json";

/**
 * How long browsing reuses a fetched catalog without asking again. Installing
 * or updating never reuses one: it always revalidates, since a cached copy may
 * still list a release that was pulled.
 */
export const PLUGIN_CATALOG_BROWSE_TTL_MS = 15 * 60 * 1000;

/** Fetch timeout ceiling for the headers and body together, matching the blocklist's. */
export const PLUGIN_CATALOG_FETCH_TIMEOUT_MS = 8000;

/** A body larger than this is refused rather than parsed. */
export const PLUGIN_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

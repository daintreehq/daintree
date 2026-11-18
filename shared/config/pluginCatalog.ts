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
 * Folder under `app.getPath("userData")` holding one cache per catalog the user
 * added (#17434), named by the SHA-256 of its URL. Daintree's own keeps
 * {@link PLUGIN_CATALOG_CACHE_FILENAME}.
 */
export const PLUGIN_CATALOG_SOURCE_CACHE_DIR = "plugin-catalogs";

/** How many catalogs a person can add beside Daintree's own. */
export const PLUGIN_CATALOG_SOURCES_MAX = 8;

/** The longest catalog URL accepted, before and after it is normalized. */
export const PLUGIN_CATALOG_SOURCE_URL_MAX_LENGTH = 2048;

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

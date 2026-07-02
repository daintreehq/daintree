/**
 * Configuration for the plugin blocklist / kill-switch (#10891).
 *
 * A small remote list of plugins Daintree refuses to load — the cheaper,
 * faster precursor to full publisher-identity signing. Fetched once at
 * startup from a Daintree-controlled endpoint, cached on disk for offline
 * enforcement, and matched by `{ name, versionRange }` (with `jti` reserved
 * for a future signed-identity model). The fetch fails open: a network or
 * parse failure never blocks a user's plugins.
 */

/**
 * Remote blocklist endpoint. Served from the same CDN as the update feeds
 * (`updates.daintree.org`). The server-side resource is owned by product;
 * tests inject a `fetchImpl` and never hit the network.
 */
export const PLUGIN_BLOCKLIST_URL = "https://updates.daintree.org/plugins/blocklist.json";

/** On-disk cache filename under `app.getPath("userData")`. */
export const PLUGIN_BLOCKLIST_CACHE_FILENAME = "plugin-blocklist.json";

/**
 * Cache freshness window. Shorter than the 24h model-catalog TTL because a
 * kill-switch entry should propagate to already-running installs within a few
 * hours, not a day. On a cache older than this the next startup re-fetches;
 * a stale cache is still enforced while offline (stale-while-revalidate).
 */
export const PLUGIN_BLOCKLIST_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch timeout ceiling. Bounds how long a hung CDN can delay plugin loading
 * at startup before the fetch aborts and enforcement falls back to the disk
 * cache (or fails open if there is none).
 */
export const PLUGIN_BLOCKLIST_FETCH_TIMEOUT_MS = 8000;

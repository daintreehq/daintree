import publishedBlocklist from "../../../plugins/blocklist.json" with { type: "json" };

/**
 * Release-shipped snapshot of the remote plugin blocklist (#14127). A fresh
 * profile enforces this at startup instead of waiting on the network, then
 * revalidates against `PLUGIN_BLOCKLIST_URL` in the background; any validated
 * cache on disk or in memory always wins over it. It is the reviewed list in
 * `plugins/blocklist.json` as of the commit a release is built from, the same
 * file `publish-plugin-blocklist.yml` publishes to that URL (#16774), and is
 * parsed with the same schema as a fetched list.
 */
export const PLUGIN_BLOCKLIST_SEED: unknown = publishedBlocklist;

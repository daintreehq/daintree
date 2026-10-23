import { PLUGIN_BLOCKLIST_URL } from "../../../shared/config/pluginBlocklist.js";

/**
 * Release-shipped snapshot of the remote plugin blocklist (#14127). A fresh
 * profile enforces this at startup instead of waiting on the network, then
 * revalidates against {@link PLUGIN_BLOCKLIST_URL} in the background; any
 * validated cache on disk or in memory always wins over it. It is parsed with
 * the same schema as a fetched list, and a test fails the build if it stops
 * parsing. Refresh `entries` from the published list when it changes.
 */
export const PLUGIN_BLOCKLIST_SEED: unknown = {
  source: PLUGIN_BLOCKLIST_URL,
  snapshotAt: "2026-10-23",
  entries: [],
};

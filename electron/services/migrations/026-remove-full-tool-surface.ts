import type { Migration } from "../StoreMigrations.js";

/**
 * `mcpServer.fullToolSurface` was a config-file-only opt-in meant to widen the
 * external (api-key) tool surface. It never had a UI or IPC setter, and after
 * #10701 defanged it into a union with an empty add-on set it also added zero
 * tools, so it was removed outright in #11537. Strip the orphaned key: the
 * service spreads the whole `mcpServer` object when persisting, so a stale
 * value would otherwise be rewritten to disk indefinitely and would silently
 * seed any future field that reused the name.
 */
export const migration026: Migration = {
  version: 26,
  description: "Remove orphaned mcpServer.fullToolSurface key",
  up: (store) => {
    const mcpServer = store.get("mcpServer");
    if (!mcpServer || typeof mcpServer !== "object") return;

    const next = { ...mcpServer } as Record<string, unknown>;
    if (!("fullToolSurface" in next)) return;

    delete next["fullToolSurface"];
    store.set("mcpServer", next as typeof mcpServer);
  },
};

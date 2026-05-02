import type { Migration } from "../StoreMigrations.js";

/**
 * The MCP bearer token is no longer persisted in electron-store; the
 * `~/.daintree/mcp.json` discovery file (0600) is the sole source of truth and
 * the key is held in memory at runtime. Strip the legacy `mcpServer.apiKey`
 * field from existing stores so it stops accumulating as dead state.
 */
export const migration021: Migration = {
  version: 21,
  description: "Drop persistent MCP api key from electron-store",
  up: (store) => {
    const mcpServer = store.get("mcpServer");
    if (!mcpServer || typeof mcpServer !== "object") return;

    const next = { ...(mcpServer as Record<string, unknown>) };
    if ("apiKey" in next) {
      delete next.apiKey;
      store.set("mcpServer", next as typeof mcpServer);
    }
  },
};

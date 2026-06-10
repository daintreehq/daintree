import type { Migration } from "../StoreMigrations.js";
import { auditLogsStore } from "../../store.js";

/**
 * Move the MCP audit and turn-outcome ring buffers out of config.json into the
 * dedicated lazily-constructed audit-logs store. The rings were the bulk of
 * config.json, which bootstrap reads/parses twice and copies to .bak
 * synchronously before main.js loads — boot cost scaled with audit volume.
 * `auditEnabled` / `auditMaxRecords` (and `pendingErrors`, the crash-reporting
 * path) intentionally stay in config.json.
 */
export const migration022: Migration = {
  version: 22,
  description: "Move MCP audit and turn-outcome logs to dedicated audit-logs store",
  up: (store) => {
    const mcpServer = store.get("mcpServer") as Record<string, unknown> | undefined;
    if (!mcpServer || typeof mcpServer !== "object") return;
    if (!("auditLog" in mcpServer) && !("turnOutcomeLog" in mcpServer)) return;

    // path === "" means the audit-logs store fell back to in-memory — moving
    // the rings there and stripping the config.json keys would silently lose
    // them on the next restart. Leave the data in place instead; throwing here
    // would trip StoreMigrations' restore-from-backup path, which is worse
    // than deferring the move for diagnostics data.
    if (auditLogsStore.path === "") {
      console.warn(
        "[Migrations] audit-logs store is not durable; leaving audit rings in config.json"
      );
      return;
    }

    const { auditLog, turnOutcomeLog, ...rest } = mcpServer;

    if (Array.isArray(auditLog) && auditLog.length > 0) {
      const existing = auditLogsStore.get("mcpAuditLog");
      // Rings are oldest-first; migrated config.json records predate anything
      // already in the audit-logs store, so they go first.
      auditLogsStore.set("mcpAuditLog", [
        ...auditLog,
        ...(Array.isArray(existing) ? existing : []),
      ] as never);
    }
    if (Array.isArray(turnOutcomeLog) && turnOutcomeLog.length > 0) {
      const existing = auditLogsStore.get("mcpTurnOutcomeLog");
      auditLogsStore.set("mcpTurnOutcomeLog", [
        ...turnOutcomeLog,
        ...(Array.isArray(existing) ? existing : []),
      ] as never);
    }

    // Rebuild without the moved keys so they're dropped from the persisted
    // object (electron-store delete only handles top-level keys).
    store.set("mcpServer", rest as never);
  },
};

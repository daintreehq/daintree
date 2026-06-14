import type { Migration } from "../StoreMigrations.js";
import { auditLogsStore } from "../../store.js";

/**
 * Move the four remaining ring buffers out of config.json into the dedicated
 * lazily-constructed audit-logs store, completing what migration022 started
 * for the MCP rings. The rings dominate config.json size, which bootstrap
 * reads/parses synchronously and the store cache snapshots whole — boot and
 * write cost scaled with audit volume. Config flags (`auditEnabled`,
 * `auditMaxRecords`) intentionally stay in config.json.
 */
const RING_MOVES = [
  { sourceKey: "plugins", ringKey: "auditLog", targetKey: "pluginAuditLog" },
  { sourceKey: "forgeAudit", ringKey: "auditLog", targetKey: "forgeAuditLog" },
  { sourceKey: "runHistory", ringKey: "records", targetKey: "runHistoryRecords" },
  { sourceKey: "pluginMcpAudit", ringKey: "auditLog", targetKey: "pluginMcpAuditLog" },
] as const;

export const migration023: Migration = {
  version: 23,
  description: "Move plugin, forge, run-history, and plugin-MCP rings to the audit-logs store",
  up: (store) => {
    const get = store.get.bind(store) as (key: string) => unknown;
    const set = store.set.bind(store) as (key: string, value: unknown) => void;

    const pending = RING_MOVES.filter((move) => {
      const slice = get(move.sourceKey);
      return slice !== null && typeof slice === "object" && move.ringKey in slice;
    });
    if (pending.length === 0) return;

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

    for (const move of pending) {
      const slice = get(move.sourceKey) as Record<string, unknown>;
      const { [move.ringKey]: ring, ...rest } = slice;

      if (Array.isArray(ring) && ring.length > 0) {
        const existing = auditLogsStore.get(move.targetKey);
        const existingRecords = Array.isArray(existing) ? existing : [];
        // Idempotency guard for partial-failure retries: if a previous run
        // copied this ring but failed before stripping the source key (or a
        // later migration failed and config.json was restored from backup),
        // the records are already in the audit-logs store — prepending again
        // would duplicate them. Every ring record carries a unique `id`.
        const firstId = (ring[0] as { id?: unknown }).id;
        const alreadyMigrated =
          typeof firstId === "string" &&
          existingRecords.some((record) => (record as { id?: unknown })?.id === firstId);
        if (!alreadyMigrated) {
          // Rings are oldest-first; migrated config.json records predate
          // anything already in the audit-logs store, so they go first.
          auditLogsStore.set(move.targetKey, [...ring, ...existingRecords] as never);
        }
      } else if (ring !== undefined && !Array.isArray(ring)) {
        // Corrupt (non-array) ring value — it is about to be stripped without
        // a copy; leave a trace so the discard isn't silent.
        console.warn(
          `[Migrations] Dropping corrupt non-array ring at ${move.sourceKey}.${move.ringKey}`
        );
      }

      // Rebuild without the moved key so it's dropped from the persisted
      // object (electron-store delete only handles top-level keys).
      set(move.sourceKey, rest);
    }
  },
};

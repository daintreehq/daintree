// eager-import-allow: reads/writes audit ring records via the shared SQLite DB
import type Database from "better-sqlite3";
import { getSharedSqlite } from "./db.js";
import { fenceDbWorkerWrites, runDbWork } from "./dbWorkerClient.js";

export type AuditRingName =
  | "mcpAuditLog"
  | "mcpTurnOutcomeLog"
  | "pluginAuditLog"
  | "forgeAuditLog"
  | "runHistoryRecords"
  | "pluginMcpAuditLog";

/**
 * SQLite-backed append-only ring buffer replacing the electron-store audit-logs
 * JSON file. Uses prepared statements and immediate transactions so each flush
 * is O(ring-size) inserts instead of a full JSON rewrite + fsync. Old
 * electron-store data is superseded on first write; consumers tolerate empty
 * rings on first hydration (they re-populate on first activity).
 */
class AuditRingStore {
  private sqlite: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;
  private trimStmt: Database.Statement | null = null;
  private clearStmt: Database.Statement | null = null;
  private readStmt: Database.Statement | null = null;

  private db(): Database.Database | null {
    if (!this.sqlite) {
      this.sqlite = getSharedSqlite();
    }
    return this.sqlite;
  }

  private prepareAll(sqlite: Database.Database): void {
    if (this.insertStmt) return;
    this.insertStmt = sqlite.prepare(
      "INSERT INTO audit_rings (ring, record, created_at) VALUES (?, ?, ?)"
    );
    // Keep the newest N rows; delete the rest.
    this.trimStmt = sqlite.prepare(
      "DELETE FROM audit_rings WHERE ring = ? AND id NOT IN (SELECT id FROM audit_rings WHERE ring = ? ORDER BY id DESC LIMIT ?)"
    );
    this.clearStmt = sqlite.prepare("DELETE FROM audit_rings WHERE ring = ?");
    this.readStmt = sqlite.prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC");
  }

  /** Read all persisted records for a ring, oldest first. Returns [] if none. */
  readAll<T>(ring: AuditRingName): T[] {
    const sqlite = this.db();
    if (!sqlite) return [];
    try {
      this.prepareAll(sqlite);
      const rows = this.readStmt!.all(ring) as { record: string }[];
      return rows
        .map((row) => {
          try {
            return JSON.parse(row.record) as T;
          } catch {
            return null;
          }
        })
        .filter((r): r is T => r !== null);
    } catch (error) {
      console.warn(`[AuditRingStore] readAll failed for "${ring}":`, error);
      return [];
    }
  }

  /**
   * Overwrite the ring with a new array, trimming to `maxRecords`. Runs inside
   * an immediate transaction so readers always see a consistent snapshot.
   *
   * The write is a full-snapshot rewrite (last write wins) whose result no
   * caller consumes, so it runs on the DB worker thread; when the worker is
   * unavailable it falls back to the synchronous main-thread path. Safe because
   * every ring's owner hydrates via readAll BEFORE its first write and treats
   * its in-memory array as the source of truth afterwards.
   *
   * `options.sync` is for flushNow()-style critical moments (clear, dispose,
   * session teardown) that need the snapshot durable on return: the write runs
   * synchronously on the main connection, after advancing the write fence so a
   * snapshot still queued on the worker can never land on top of it.
   */
  writeAll<T>(
    ring: AuditRingName,
    records: T[],
    maxRecords: number,
    options?: { sync?: boolean }
  ): void {
    let serialized: string[];
    try {
      serialized = records.map((record) => JSON.stringify(record));
    } catch (error) {
      console.warn(`[AuditRingStore] writeAll failed for "${ring}":`, error);
      return;
    }
    if (options?.sync) {
      fenceDbWorkerWrites();
      this.writeAllSerialized(ring, serialized, maxRecords);
      return;
    }
    void runDbWork({ op: "ringWriteAll", ring, records: serialized, maxRecords }, () =>
      this.writeAllSerialized(ring, serialized, maxRecords)
    );
  }

  private writeAllSerialized(ring: AuditRingName, records: string[], maxRecords: number): void {
    const sqlite = this.db();
    if (!sqlite) return;
    try {
      this.prepareAll(sqlite);
      const now = Date.now();
      const insert = this.insertStmt!;
      const trim = this.trimStmt!;
      const clear = this.clearStmt!;

      sqlite
        .transaction(() => {
          clear.run(ring);
          for (const record of records) {
            insert.run(ring, record, now);
          }
          if (maxRecords > 0) {
            trim.run(ring, ring, maxRecords);
          }
        })
        .immediate();
    } catch (error) {
      console.warn(`[AuditRingStore] writeAll failed for "${ring}":`, error);
    }
  }
}

export const auditRingStore = new AuditRingStore();

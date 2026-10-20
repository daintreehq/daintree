// The audit_rings write executors, shared by AuditRingStore's main-thread path
// and the DB worker so the two can never drift apart. Must stay free of
// Electron (and db.ts) imports: the worker bundles this module.
import type Database from "better-sqlite3";

/** One persisted row. `recordId` is null when the record has no usable unique id. */
export interface RingRow {
  recordId: string | null;
  record: string;
}

export interface RingStatements {
  insert: Database.Statement;
  upsert: Database.Statement;
  deleteOne: Database.Statement;
  trim: Database.Statement;
  clear: Database.Statement;
}

export function prepareRingStatements(sqlite: Database.Database): RingStatements {
  return {
    insert: sqlite.prepare(
      "INSERT INTO audit_rings (ring, record_id, record, created_at) VALUES (?, ?, ?, ?)"
    ),
    // ON CONFLICT ... DO UPDATE keeps the row's numeric id, so an updated record
    // keeps its place in the ring; INSERT OR REPLACE would move it to the end.
    // created_at stays the first-insert time — age logic reads each record's own
    // timestamp, never this column.
    upsert: sqlite.prepare(
      "INSERT INTO audit_rings (ring, record_id, record, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(ring, record_id) DO UPDATE SET record = excluded.record"
    ),
    deleteOne: sqlite.prepare("DELETE FROM audit_rings WHERE ring = ? AND record_id = ?"),
    // Keep the newest N rows; delete the rest.
    trim: sqlite.prepare(
      "DELETE FROM audit_rings WHERE ring = ? AND id NOT IN (SELECT id FROM audit_rings WHERE ring = ? ORDER BY id DESC LIMIT ?)"
    ),
    clear: sqlite.prepare("DELETE FROM audit_rings WHERE ring = ?"),
  };
}

/**
 * Atomically replace a ring's rows. `guard` runs inside the immediate
 * transaction (the worker's write-fence check); returning false aborts the
 * write. Resolves true only when the rows were written.
 */
export function replaceRing(
  sqlite: Database.Database,
  stmts: RingStatements,
  ring: string,
  rows: RingRow[],
  maxRecords: number,
  guard: () => boolean = () => true
): boolean {
  const now = Date.now();
  let applied = false;
  sqlite
    .transaction(() => {
      if (!guard()) return;
      stmts.clear.run(ring);
      for (const row of rows) {
        stmts.insert.run(ring, row.recordId, row.record, now);
      }
      if (maxRecords > 0) {
        stmts.trim.run(ring, ring, maxRecords);
      }
      applied = true;
    })
    .immediate();
  return applied;
}

/**
 * Apply a keyed delta: delete vanished ids, then upsert new or changed rows in
 * order. Keyed, so replaying a delta that already committed is harmless.
 */
export function applyRingDelta(
  sqlite: Database.Database,
  stmts: RingStatements,
  ring: string,
  upserts: RingRow[],
  deletes: string[],
  guard: () => boolean = () => true
): boolean {
  const now = Date.now();
  let applied = false;
  sqlite
    .transaction(() => {
      if (!guard()) return;
      for (const recordId of deletes) {
        stmts.deleteOne.run(ring, recordId);
      }
      for (const row of upserts) {
        stmts.upsert.run(ring, row.recordId, row.record, now);
      }
      applied = true;
    })
    .immediate();
  return applied;
}

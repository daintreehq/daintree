// Persistent worker thread that services deferrable SQLite work (WAL
// checkpoints, quick_check scans, audit-ring snapshot writes) so better-sqlite3
// never stalls the main-process event loop for them. Opens its OWN connection
// to the same WAL database — safe alongside main's connection because WAL
// permits concurrent readers plus a single writer, and both connections set a
// busy_timeout so write contention blocks briefly instead of throwing
// SQLITE_BUSY.
import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { DbWorkerData, DbWorkerRequest, DbWorkerResponse } from "./dbWorkerProtocol.js";

const port = parentPort;
if (!port) {
  throw new Error("dbMaintenanceWorker must be spawned as a worker thread");
}

const { dbPath } = workerData as DbWorkerData;

// Main's openDb/migrate always runs before this worker spawns (the client only
// spawns once the shared handle exists) — never create or migrate from here.
const sqlite = new Database(dbPath, { fileMustExist: true });
sqlite.pragma("journal_mode = WAL");
// Intentionally above main's 3000ms: under write contention the worker must
// out-wait main rather than throw SQLITE_BUSY at it.
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("synchronous = NORMAL");
// Mirror openDb's per-connection perf pragmas (db.ts) — without them
// quick_check and the ring-write transactions run on SQLite defaults
// (mmap_size especially matters for quick_check on a large DB).
sqlite.pragma("temp_store = MEMORY");
sqlite.pragma("mmap_size = 10737418240");
sqlite.pragma("cache_size = -65536");
sqlite.pragma("journal_size_limit = 5242880");
sqlite.pragma("foreign_keys = ON");

interface RingStatements {
  insert: Database.Statement;
  trim: Database.Statement;
  clear: Database.Statement;
}

let ringStatements: RingStatements | null = null;

// Mirrors AuditRingStore's SQL exactly — the worker is an alternate executor
// for the same audit_rings table, not a second schema owner.
function getRingStatements(): RingStatements {
  if (!ringStatements) {
    ringStatements = {
      insert: sqlite.prepare("INSERT INTO audit_rings (ring, record, created_at) VALUES (?, ?, ?)"),
      trim: sqlite.prepare(
        "DELETE FROM audit_rings WHERE ring = ? AND id NOT IN (SELECT id FROM audit_rings WHERE ring = ? ORDER BY id DESC LIMIT ?)"
      ),
      clear: sqlite.prepare("DELETE FROM audit_rings WHERE ring = ?"),
    };
  }
  return ringStatements;
}

// Full quick_check against an arbitrary file on its own short-lived readonly
// handle. Deliberately duplicates db.ts's probeDb rather than importing it: that
// module imports Electron's `app` at module scope, which does not exist inside a
// worker thread. Corruption resolves false; any other open/IO failure throws so
// the client falls back to probing on main.
function probePath(dbPath: string): boolean {
  let candidate: Database.Database | null = null;
  try {
    candidate = new Database(dbPath, { readonly: true, fileMustExist: true });
    return candidate.pragma("quick_check", { simple: true }) === "ok";
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (
      typeof code === "string" &&
      (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB")
    ) {
      return false;
    }
    throw error;
  } finally {
    try {
      candidate?.close();
    } catch {
      // ignore close errors
    }
  }
}

function execute(request: DbWorkerRequest): unknown {
  switch (request.op) {
    case "checkpoint":
      sqlite.pragma(`wal_checkpoint(${request.mode})`);
      return null;
    case "quickCheck":
      return sqlite.pragma("quick_check", { simple: true });
    case "probePath":
      return probePath(request.dbPath);
    case "ringWriteAll": {
      const { ring, records, maxRecords, fence } = request;
      const { insert, trim, clear } = getRingStatements();
      const now = Date.now();
      let applied = false;
      sqlite
        .transaction(() => {
          // Write-fence check INSIDE the immediate transaction: BEGIN IMMEDIATE
          // holds the write lock and sees the latest committed snapshot, so a
          // fence bump main committed before its fallback write is always
          // visible here — a stale queued snapshot can never clobber newer
          // main-thread data. SQLite's writer serialization makes this atomic.
          const epoch = Number(sqlite.pragma("user_version", { simple: true }));
          if (epoch !== fence) return;
          clear.run(ring);
          for (const record of records) {
            insert.run(ring, record, now);
          }
          if (maxRecords > 0) {
            trim.run(ring, ring, maxRecords);
          }
          applied = true;
        })
        .immediate();
      return applied;
    }
    case "close":
      sqlite.close();
      return null;
  }
}

port.on("message", (request: DbWorkerRequest) => {
  let response: DbWorkerResponse;
  try {
    response = { id: request.id, ok: true, result: execute(request) };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: formatErrorMessage(error, "db worker op failed"),
    };
  }
  port.postMessage(response);
  if (request.op === "close") {
    port.close();
  }
});

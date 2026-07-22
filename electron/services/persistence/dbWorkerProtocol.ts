export interface DbWorkerData {
  dbPath: string;
}

/**
 * Verdict on a SQLite file's integrity. "unknown" (could not be verified — the
 * file is missing, locked, or unreadable) is deliberately distinct from
 * "corrupt" (quick_check proved it bad): a caller about to overwrite the last
 * known-good backup must treat both as "do not promote", but only "corrupt" is
 * evidence that the source database itself is damaged.
 */
export type DbProbeResult = "ok" | "corrupt" | "unknown";

export type DbWorkerOp =
  | { op: "checkpoint"; mode: "PASSIVE" | "TRUNCATE" }
  | { op: "quickCheck" }
  // Full quick_check against an arbitrary SQLite file (not the worker's own
  // connection) — used to verify a freshly written backup before it replaces
  // the last known-good one. Resolves true only on an exact "ok".
  | { op: "probePath"; dbPath: string }
  | { op: "ringWriteAll"; ring: string; records: string[]; maxRecords: number }
  | { op: "close" };

// `fence` is the write-fence epoch (PRAGMA user_version — unused elsewhere in
// the schema) current when the request was posted. The worker re-reads
// user_version inside its immediate write transaction and no-ops any ring
// write whose epoch no longer matches — this is how main invalidates stale
// queued snapshots after a degrade or a shutdown-drain timeout. Idempotent ops
// (checkpoint, quickCheck, probePath) ignore it.
export type DbWorkerRequest = DbWorkerOp & { id: number; fence: number };

export type DbWorkerResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

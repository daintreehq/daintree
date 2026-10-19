import type Database from "better-sqlite3";

const TERMINAL_STATES_SQL = ["completed", "canceled", "failed", "rejected"]
  .map((state) => `'${state}'`)
  .join(", ");

function hasJournal(sqlite: Database.Database): boolean {
  return (
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_exchange_journal'"
      )
      .get() !== undefined
  );
}

/**
 * The messages this Shell sent to hosts' assistants through the inbox that
 * were still open when it was retired (#13496), by host: answered by nothing
 * yet, or sent with no answer heard. Nothing will reply to them now, which an
 * assistant here is told before the records go.
 */
export function readRetiredSends(
  sqlite: Database.Database,
  now: number = Date.now()
): Array<{ hostId: string; count: number }> {
  if (!hasJournal(sqlite)) return [];
  return sqlite
    .prepare(
      `SELECT host_id AS hostId, COUNT(*) AS count FROM assistant_exchange_journal WHERE
         (record IS NOT NULL AND json_extract(record, '$.state') NOT IN (${TERMINAL_STATES_SQL}) AND json_extract(record, '$.expiresAt') > ?)
         OR unresolved_at IS NOT NULL
       GROUP BY host_id ORDER BY host_id`
    )
    .all(now) as Array<{ hostId: string; count: number }>;
}

/** Every journal record goes once an assistant here has been told: nothing reads them again. */
export function forgetRetiredSends(sqlite: Database.Database): void {
  if (!hasJournal(sqlite)) return;
  sqlite.prepare("DELETE FROM assistant_exchange_journal").run();
}

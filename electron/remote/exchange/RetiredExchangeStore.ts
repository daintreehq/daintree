import type Database from "better-sqlite3";
import { AppError, isAppError } from "../../utils/errorTypes.js";
import {
  TERMINAL_EXCHANGE_STATES,
  type ExchangeChanges,
  type ExchangeKey,
  type ExchangeRecord,
  type ExchangeState,
  type ExchangeSweepResult,
  type SenderActor,
} from "./types.js";

/** Tombstones outlast the hour a v0.44 Shell may still resend in, then go. */
export const EXCHANGE_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const EXCHANGE_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** What an exchange still open when its inbox was retired ended as. */
export const RETIRED_OUTCOME = "messaging_retired";

const MAX_LIST_LIMIT = 500;
const TERMINAL_STATES_SQL = [...TERMINAL_EXCHANGE_STATES].map((state) => `'${state}'`).join(", ");

interface ExchangeRow {
  task_id: string;
  sender_id: string;
  message_id: string;
  context_id: string;
  reference_task_ids: string;
  receiver_host_id: string;
  receiver_lane_id: string;
  enrollment_generation: string;
  state: ExchangeState;
  outcome: string | null;
  payload_digest: string;
  body_digest: string;
  body_bytes: number;
  reply_digest: string | null;
  reply_bytes: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  revision: number;
  delivery_attempted_at: number | null;
  accepted_at: number | null;
  wake_typed_at: number | null;
  inbox_fetched_at: number | null;
  reply_received_at: number | null;
  ambiguous_at: number | null;
  cancel_requested_at: number | null;
  terminal_at: number | null;
  tombstoned_at: number | null;
  purge_after: number | null;
}

const MUTABLE_COLUMNS = [
  "state",
  "outcome",
  "updated_at",
  "revision",
  "terminal_at",
  "tombstoned_at",
  "purge_after",
] as const satisfies readonly (keyof ExchangeRow)[];

type ExchangeEvent = "retired" | "expired" | "purged";

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError({
      code: "VALIDATION",
      message: "Exchange page limit must be a positive integer",
    });
  }
  return Math.min(MAX_LIST_LIMIT, value);
}

function isTerminal(row: ExchangeRow): boolean {
  return TERMINAL_EXCHANGE_STATES.has(row.state);
}

function toRecord(row: ExchangeRow): ExchangeRecord {
  return {
    taskId: row.task_id,
    senderId: row.sender_id,
    messageId: row.message_id,
    contextId: row.context_id,
    referenceTaskIds: JSON.parse(row.reference_task_ids) as string[],
    receiver: {
      hostId: row.receiver_host_id,
      laneId: row.receiver_lane_id,
      enrollmentGeneration: row.enrollment_generation,
    },
    state: row.state,
    outcome: row.outcome,
    bodyDigest: row.body_digest,
    bodyBytes: row.body_bytes,
    replyDigest: row.reply_digest,
    replyBytes: row.reply_bytes,
    delivery: {
      attemptedAt: row.delivery_attempted_at,
      acceptedAt: row.accepted_at,
      wakeTypedAt: row.wake_typed_at,
      inboxFetchedAt: row.inbox_fetched_at,
      replyReceivedAt: row.reply_received_at,
      ambiguousAt: row.ambiguous_at,
    },
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    terminalAt: row.terminal_at,
    tombstonedAt: row.tombstoned_at,
    revision: row.revision,
  };
}

export interface RetiredExchangeStoreOptions {
  now?: () => number;
  tombstoneRetentionMs?: number;
  auditRetentionMs?: number;
}

/**
 * The exchanges a host took before the inbox was retired (#13496), kept only
 * so a v0.44 Shell that sent them reads how they ended. Nothing new is ever
 * recorded: `retireOpen` ends what was still open, each read is the sender's
 * own, and the sweep expires and purges the rest as before until the tables
 * are empty. Message bodies were never kept.
 *
 * Fails closed: with no database, or a write that doesn't land, every call
 * throws PERSIST_FAILED rather than answering "not found" — a Shell that read
 * that as "never sent" would send the message again.
 */
export class RetiredExchangeStore {
  private readonly now: () => number;
  private readonly tombstoneRetentionMs: number;
  private readonly auditRetentionMs: number;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(
    private readonly sqlite: Database.Database | null,
    options: RetiredExchangeStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.tombstoneRetentionMs = options.tombstoneRetentionMs ?? EXCHANGE_TOMBSTONE_RETENTION_MS;
    this.auditRetentionMs = options.auditRetentionMs ?? EXCHANGE_AUDIT_RETENTION_MS;
  }

  /** The sender's own record, or null if it has none. */
  get(sender: SenderActor, key: ExchangeKey): ExchangeRecord | null {
    return this.read((sqlite) => {
      const row = this.statement(
        sqlite,
        "SELECT * FROM assistant_exchanges WHERE sender_id = ? AND message_id = ?"
      ).get(key.senderId, key.messageId) as ExchangeRow | undefined;
      return row && row.sender_id === sender.senderId ? toRecord(row) : null;
    });
  }

  /**
   * The sender's records whose revision is past `cursor`, oldest change
   * first, each at its latest state. A cursor older than a purge gets
   * `reset: true` and a listing from the beginning, so a removal is never
   * silently skipped.
   */
  listChangesSince(sender: SenderActor, cursor: number, limit = 100): ExchangeChanges {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new AppError({
        code: "VALIDATION",
        message: "Exchange cursor must be a non-negative integer",
      });
    }
    const pageSize = requireLimit(limit);
    return this.read((sqlite) => {
      const clock = this.readClock(sqlite);
      const reset = cursor < clock.min_cursor;
      const from = reset ? 0 : cursor;
      const rows = this.statement(
        sqlite,
        "SELECT * FROM assistant_exchanges WHERE sender_id = ? AND revision > ? ORDER BY revision LIMIT ?"
      ).all(sender.senderId, from, pageSize + 1) as ExchangeRow[];
      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      return {
        records: page.map(toRecord),
        cursor: hasMore ? page[page.length - 1]!.revision : Math.max(clock.revision, from),
        hasMore,
        reset,
      };
    }, true);
  }

  /**
   * Fails every exchange still open, with outcome {@link RETIRED_OUTCOME}:
   * this build takes no messages and delivers none, so nothing can answer one
   * now. Each gets a new revision, so a Shell reading by cursor sees it end
   * rather than wait out its TTL. Bounded per call; `hasMore` asks for another.
   */
  retireOpen(limit = MAX_LIST_LIMIT): { failed: number; hasMore: boolean } {
    const batch = requireLimit(limit);
    return this.write((sqlite) => {
      const now = this.now();
      const open = this.statement(
        sqlite,
        `SELECT * FROM assistant_exchanges WHERE tombstoned_at IS NULL AND state NOT IN (${TERMINAL_STATES_SQL}) ORDER BY revision LIMIT ?`
      ).all(batch + 1) as ExchangeRow[];
      const failing = open.slice(0, batch);
      for (const row of failing) {
        this.apply(
          sqlite,
          row,
          "retired",
          { state: "failed", outcome: RETIRED_OUTCOME, terminal_at: now },
          now
        );
      }
      return { failed: failing.length, hasMore: open.length > batch };
    });
  }

  /**
   * Expires records past their TTL into tombstones, purges tombstones past
   * their retention and drops old audit rows. Bounded per call; `hasMore`
   * asks for another.
   */
  sweep(limit = MAX_LIST_LIMIT): ExchangeSweepResult {
    const batch = requireLimit(limit);
    return this.write((sqlite) => {
      const now = this.now();
      const due = this.statement(
        sqlite,
        "SELECT * FROM assistant_exchanges WHERE tombstoned_at IS NULL AND expires_at <= ? ORDER BY expires_at, revision LIMIT ?"
      ).all(now, batch + 1) as ExchangeRow[];
      const expiring = due.slice(0, batch);
      for (const row of expiring) {
        const next: Partial<ExchangeRow> = {
          tombstoned_at: now,
          purge_after: now + this.tombstoneRetentionMs,
        };
        if (!isTerminal(row)) {
          next.state = "failed";
          next.outcome = "expired";
          next.terminal_at = now;
        }
        this.apply(sqlite, row, "expired", next, now);
      }

      // Purge only from the bottom of the revision order, stopping at the first
      // row that must stay. Every retained row then sits above `min_cursor`,
      // so a listing restarted after a reset pages forward without tripping
      // the reset again.
      const oldest = this.statement(
        sqlite,
        "SELECT * FROM assistant_exchanges ORDER BY revision LIMIT ?"
      ).all(batch + 1) as ExchangeRow[];
      const purgeable = (row: ExchangeRow | undefined) =>
        row !== undefined && row.tombstoned_at !== null && (row.purge_after ?? Infinity) <= now;
      const purging: ExchangeRow[] = [];
      for (const row of oldest.slice(0, batch)) {
        if (!purgeable(row)) break;
        purging.push(row);
      }
      if (purging.length > 0) {
        const purgedThrough = Math.max(...purging.map((row) => row.revision));
        const remove = this.statement(sqlite, "DELETE FROM assistant_exchanges WHERE task_id = ?");
        for (const row of purging) {
          remove.run(row.task_id);
          this.audit(sqlite, row, "purged", row.state, now);
        }
        // A cursor at or past the last revision any purged row held saw it as
        // a tombstone; one before that would miss the removal, so it resets.
        this.statement(
          sqlite,
          "UPDATE assistant_exchange_clock SET min_cursor = max(min_cursor, ?) WHERE id = 1"
        ).run(purgedThrough);
      }

      const auditPurged = this.statement(
        sqlite,
        "DELETE FROM assistant_exchange_audit WHERE revision IN (SELECT revision FROM assistant_exchange_audit WHERE purge_after <= ? ORDER BY revision LIMIT ?)"
      ).run(now, batch).changes;

      return {
        expired: expiring.length,
        purged: purging.length,
        auditPurged,
        hasMore:
          due.length > batch ||
          (purging.length === batch && purgeable(oldest[batch])) ||
          auditPurged >= batch,
      };
    });
  }

  private apply(
    sqlite: Database.Database,
    row: ExchangeRow,
    event: ExchangeEvent,
    next: Partial<ExchangeRow>,
    now: number
  ): ExchangeRow {
    const updated: ExchangeRow = {
      ...row,
      ...next,
      updated_at: now,
      revision: this.nextRevision(sqlite),
    };
    this.statement(
      sqlite,
      `UPDATE assistant_exchanges SET ${MUTABLE_COLUMNS.map((c) => `${c} = @${c}`).join(", ")} WHERE task_id = @task_id`
    ).run(updated);
    this.audit(sqlite, updated, event, row.state, now);
    return updated;
  }

  /** Metadata only, from an allowlist: no body, no free text. */
  private audit(
    sqlite: Database.Database,
    row: ExchangeRow,
    event: ExchangeEvent,
    previousState: ExchangeState,
    now: number
  ): void {
    const revision = event === "purged" ? this.nextRevision(sqlite) : row.revision;
    const attributes: Record<string, string | number> = {
      "daintree.exchange.event": event,
      "daintree.exchange.message_id": row.message_id,
      "daintree.exchange.task_id": row.task_id,
      "daintree.exchange.sender_id": row.sender_id,
      "daintree.exchange.revision": revision,
      "daintree.exchange.state": row.state,
      "daintree.exchange.previous_state": previousState,
      "daintree.exchange.outcome": row.outcome ?? row.state,
    };
    this.statement(
      sqlite,
      "INSERT INTO assistant_exchange_audit (revision, task_id, sender_id, occurred_at, purge_after, attributes) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      revision,
      row.task_id,
      row.sender_id,
      now,
      now + this.auditRetentionMs,
      JSON.stringify(attributes)
    );
  }

  private nextRevision(sqlite: Database.Database): number {
    const row = this.statement(
      sqlite,
      "INSERT INTO assistant_exchange_clock (id, revision, min_cursor) VALUES (1, 1, 0) ON CONFLICT(id) DO UPDATE SET revision = revision + 1 RETURNING revision"
    ).get() as { revision: number };
    return row.revision;
  }

  private readClock(sqlite: Database.Database): { revision: number; min_cursor: number } {
    const row = this.statement(
      sqlite,
      "SELECT revision, min_cursor FROM assistant_exchange_clock WHERE id = 1"
    ).get() as { revision: number; min_cursor: number } | undefined;
    return row ?? { revision: 0, min_cursor: 0 };
  }

  private statement(sqlite: Database.Database, sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = sqlite.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private write<T>(work: (sqlite: Database.Database) => T): T {
    return this.guard((sqlite) => sqlite.transaction(work).immediate(sqlite));
  }

  private read<T>(work: (sqlite: Database.Database) => T, snapshot = false): T {
    return this.guard((sqlite) =>
      snapshot ? sqlite.transaction(work).deferred(sqlite) : work(sqlite)
    );
  }

  private guard<T>(work: (sqlite: Database.Database) => T): T {
    const sqlite = this.sqlite;
    if (!sqlite || !sqlite.open) {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "Assistant exchange records are unavailable",
      });
    }
    try {
      return work(sqlite);
    } catch (error) {
      if (isAppError(error)) throw error;
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "Assistant exchange records could not be read or written",
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}

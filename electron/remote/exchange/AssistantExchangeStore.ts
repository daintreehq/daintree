import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AppError, isAppError } from "../../utils/errorTypes.js";
import {
  EXCHANGE_STATES,
  TERMINAL_EXCHANGE_STATES,
  type CreateExchangeInput,
  type CreateExchangeResult,
  type DeliveryFact,
  type ExchangeActor,
  type ExchangeChanges,
  type ExchangeKey,
  type ExchangeRecord,
  type ExchangeState,
  type ExchangeSweepResult,
  type SenderActor,
} from "./types.js";

/** How long an exchange stays live before it expires into a tombstone. */
export const EXCHANGE_TTL_MS = 24 * 60 * 60_000;
/** How long a sender may resend a message id it got no answer for. */
export const EXCHANGE_RETRY_WINDOW_MS = 60 * 60_000;
/** Tombstones must outlive the retry window, or a late resend could revive a finished exchange. */
export const EXCHANGE_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const EXCHANGE_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;

const MAX_ID_LENGTH = 256;
const MAX_REFERENCE_TASK_IDS = 64;
const MAX_LIST_LIMIT = 500;
const OUTCOME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface AssistantExchangeStoreOptions {
  now?: () => number;
  ttlMs?: number;
  retryWindowMs?: number;
  tombstoneRetentionMs?: number;
  auditRetentionMs?: number;
  newTaskId?: () => string;
}

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
  "reply_digest",
  "reply_bytes",
  "updated_at",
  "revision",
  "delivery_attempted_at",
  "accepted_at",
  "wake_typed_at",
  "inbox_fetched_at",
  "reply_received_at",
  "ambiguous_at",
  "cancel_requested_at",
  "terminal_at",
  "tombstoned_at",
  "purge_after",
] as const satisfies readonly (keyof ExchangeRow)[];

const ALL_COLUMNS = [
  "task_id",
  "sender_id",
  "message_id",
  "context_id",
  "reference_task_ids",
  "receiver_host_id",
  "receiver_lane_id",
  "enrollment_generation",
  "payload_digest",
  "body_digest",
  "body_bytes",
  "created_at",
  "expires_at",
  ...MUTABLE_COLUMNS,
] as const satisfies readonly (keyof ExchangeRow)[];

type FactColumn = "accepted_at" | "wake_typed_at" | "inbox_fetched_at" | "reply_received_at";

const FACT_COLUMNS: Record<DeliveryFact, FactColumn> = {
  accepted: "accepted_at",
  "wake-typed": "wake_typed_at",
  "inbox-fetched": "inbox_fetched_at",
  "reply-received": "reply_received_at",
};

type ExchangeEvent =
  | "created"
  | "delivery-attempted"
  | DeliveryFact
  | "ambiguous"
  | "state-changed"
  | "cancel-requested"
  | "canceled"
  | "expired"
  | "purged";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function refuse(code: "NOT_FOUND" | "VALIDATION" | "OUTCOME_UNKNOWN", message: string): AppError {
  return new AppError({ code, message });
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw refuse("VALIDATION", `Exchange ${field} must be 1-${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function requireDuration(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Exchange ${field} must be a positive, finite duration`);
  }
  return value;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw refuse("VALIDATION", "Exchange page limit must be a positive integer");
  }
  return Math.min(MAX_LIST_LIMIT, value);
}

function isTerminal(row: ExchangeRow): boolean {
  return TERMINAL_EXCHANGE_STATES.has(row.state);
}

/** Anything that may already have reached the other side makes a cancel only a request. */
function mayHaveDelivered(row: ExchangeRow): boolean {
  return (
    row.delivery_attempted_at !== null ||
    row.ambiguous_at !== null ||
    row.accepted_at !== null ||
    row.wake_typed_at !== null ||
    row.inbox_fetched_at !== null ||
    row.reply_received_at !== null
  );
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

/**
 * Durable records of cross-host assistant exchanges. Each mutation bumps one
 * revision counter, writes the record and appends exactly one metadata-only
 * audit row in a single immediate transaction; a repeat of something already
 * recorded writes nothing. Message bodies are hashed and measured, never kept.
 *
 * Fails closed: with no database, or a write that doesn't land, every call
 * throws PERSIST_FAILED rather than answering "not found" — a caller that
 * read that as "never sent" would send the message again.
 */
export class AssistantExchangeStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly tombstoneRetentionMs: number;
  private readonly auditRetentionMs: number;
  private readonly newTaskId: () => string;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(
    private readonly sqlite: Database.Database | null,
    options: AssistantExchangeStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = requireDuration(options.ttlMs ?? EXCHANGE_TTL_MS, "TTL");
    this.tombstoneRetentionMs = requireDuration(
      options.tombstoneRetentionMs ?? EXCHANGE_TOMBSTONE_RETENTION_MS,
      "tombstone retention"
    );
    this.auditRetentionMs = requireDuration(
      options.auditRetentionMs ?? EXCHANGE_AUDIT_RETENTION_MS,
      "audit retention"
    );
    this.newTaskId = options.newTaskId ?? randomUUID;
    const retryWindowMs = requireDuration(
      options.retryWindowMs ?? EXCHANGE_RETRY_WINDOW_MS,
      "retry window"
    );
    if (this.tombstoneRetentionMs <= retryWindowMs) {
      throw new Error("Exchange tombstones must be kept longer than the retry window");
    }
  }

  create(sender: SenderActor, input: CreateExchangeInput): CreateExchangeResult {
    const senderId = requireId(sender.senderId, "sender id");
    const messageId = requireId(input.messageId, "message id");
    const contextId = requireId(input.contextId, "context id");
    const hostId = requireId(input.receiver.hostId, "receiver host id");
    const laneId = requireId(input.receiver.laneId, "receiver lane id");
    const generation = requireId(input.receiver.enrollmentGeneration, "enrollment generation");
    if (
      !Array.isArray(input.referenceTaskIds) ||
      input.referenceTaskIds.length > MAX_REFERENCE_TASK_IDS
    ) {
      throw refuse(
        "VALIDATION",
        `Exchange reference task ids must be a list of at most ${MAX_REFERENCE_TASK_IDS}`
      );
    }
    // Array.from visits holes, so a sparse list can't slip a null past validation.
    const referenceTaskIds = Array.from(input.referenceTaskIds, (id) =>
      requireId(id, "reference task id")
    );
    if (typeof input.body !== "string") {
      throw refuse("VALIDATION", "Exchange body must be a string");
    }
    const bodyDigest = sha256(input.body);
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    const payloadDigest = sha256(
      JSON.stringify([contextId, referenceTaskIds, hostId, laneId, generation, bodyDigest])
    );

    return this.write((sqlite) => {
      const existing = this.selectByKey(sqlite, senderId, messageId);
      if (existing) {
        if (existing.payload_digest !== payloadDigest) {
          throw refuse(
            "VALIDATION",
            `Exchange message id ${messageId} was already used for a different message`
          );
        }
        return {
          disposition: existing.tombstoned_at !== null ? "tombstoned" : "existing",
          record: toRecord(existing),
        };
      }
      const now = this.now();
      const row: ExchangeRow = {
        task_id: this.newTaskId(),
        sender_id: senderId,
        message_id: messageId,
        context_id: contextId,
        reference_task_ids: JSON.stringify(referenceTaskIds),
        receiver_host_id: hostId,
        receiver_lane_id: laneId,
        enrollment_generation: generation,
        state: "submitted",
        outcome: null,
        payload_digest: payloadDigest,
        body_digest: bodyDigest,
        body_bytes: bodyBytes,
        reply_digest: null,
        reply_bytes: null,
        created_at: now,
        updated_at: now,
        expires_at: now + this.ttlMs,
        revision: this.nextRevision(sqlite),
        delivery_attempted_at: null,
        accepted_at: null,
        wake_typed_at: null,
        inbox_fetched_at: null,
        reply_received_at: null,
        ambiguous_at: null,
        cancel_requested_at: null,
        terminal_at: null,
        tombstoned_at: null,
        purge_after: null,
      };
      this.statement(
        sqlite,
        `INSERT INTO assistant_exchanges (${ALL_COLUMNS.join(", ")}) VALUES (${ALL_COLUMNS.map((c) => `@${c}`).join(", ")})`
      ).run(row);
      this.audit(sqlite, row, "created", null, now);
      return { disposition: "created", record: toRecord(row) };
    });
  }

  /**
   * Call before anything leaves for the receiver. Once an attempt, an
   * observed fact or an unknown outcome is on record, the exchange is never
   * sent again, across restarts too: a duplicate wake is tolerable and
   * duplicate execution isn't.
   */
  beginDelivery(actor: ExchangeActor, key: ExchangeKey): ExchangeRecord {
    return this.transition(actor, key, (row) => {
      if (mayHaveDelivered(row)) {
        throw refuse(
          "OUTCOME_UNKNOWN",
          `Exchange ${row.message_id} may already have been delivered and is not sent again`
        );
      }
      if (isTerminal(row)) {
        throw refuse("VALIDATION", `Exchange ${row.message_id} is already ${row.state}`);
      }
      return { event: "delivery-attempted", next: { delivery_attempted_at: this.now() } };
    });
  }

  /**
   * Records a delivery fact the first time it is seen; a repeat is a no-op.
   * A reply moves a live exchange to `completed` in the same write. A fact
   * that arrives after a terminal state is still recorded, and the state
   * stays where it was.
   */
  recordDelivery(
    actor: ExchangeActor,
    key: ExchangeKey,
    fact: DeliveryFact,
    reply?: { body: string }
  ): ExchangeRecord {
    const column = FACT_COLUMNS[fact];
    if (!column) throw refuse("VALIDATION", `Unknown exchange delivery fact ${String(fact)}`);
    if (fact === "reply-received" && typeof reply?.body !== "string") {
      throw refuse("VALIDATION", "A received reply must carry its body to be measured");
    }
    return this.transition(actor, key, (row) => {
      if (row[column] !== null) return null;
      const now = this.now();
      const next: Partial<ExchangeRow> = {};
      next[column] = now;
      if (fact === "reply-received" && reply) {
        next.reply_digest = sha256(reply.body);
        next.reply_bytes = Buffer.byteLength(reply.body, "utf8");
        if (!isTerminal(row)) {
          next.state = "completed";
          next.terminal_at = now;
        }
      }
      return { event: fact, next };
    });
  }

  /** The outcome is unknown. Recorded alongside the state, which it never changes. */
  markAmbiguous(actor: ExchangeActor, key: ExchangeKey): ExchangeRecord {
    return this.transition(actor, key, (row) => {
      if (row.ambiguous_at !== null) return null;
      return { event: "ambiguous", next: { ambiguous_at: this.now() } };
    });
  }

  /**
   * Moves a live exchange between states. `completed` is reached only by a
   * recorded reply and `canceled` only through `requestCancel`; a terminal
   * state never changes again.
   */
  setState(
    actor: ExchangeActor,
    key: ExchangeKey,
    state: ExchangeState,
    outcome?: string
  ): ExchangeRecord {
    if (!(EXCHANGE_STATES as readonly string[]).includes(state)) {
      throw refuse("VALIDATION", `Unknown exchange state ${String(state)}`);
    }
    if (state === "canceled") {
      throw refuse("VALIDATION", "An exchange is canceled through a cancel request");
    }
    if (outcome !== undefined && !OUTCOME_PATTERN.test(outcome)) {
      throw refuse("VALIDATION", "Exchange outcome must be a short lowercase code");
    }
    return this.transition(actor, key, (row) => {
      if (row.state === state && (outcome === undefined || row.outcome === outcome)) return null;
      if (isTerminal(row)) {
        throw refuse("VALIDATION", `Exchange ${row.message_id} is already ${row.state}`);
      }
      if (state === "completed" && row.reply_received_at === null) {
        throw refuse("VALIDATION", `Exchange ${row.message_id} has no reply to complete it`);
      }
      const next: Partial<ExchangeRow> = { state, outcome: outcome ?? row.outcome };
      if (TERMINAL_EXCHANGE_STATES.has(state)) next.terminal_at = this.now();
      return { event: "state-changed", next };
    });
  }

  /**
   * Cancels an exchange nothing has left for yet. Once a delivery was
   * attempted, observed or left unknown, the other assistant may already be
   * acting on it, so the request is recorded and the state stays.
   */
  requestCancel(sender: SenderActor, key: ExchangeKey): ExchangeRecord {
    if (sender.kind !== "sender") {
      throw refuse("VALIDATION", "Only the sender can cancel an exchange");
    }
    return this.transition(sender, key, (row) => {
      if (row.cancel_requested_at !== null) return null;
      const now = this.now();
      if (isTerminal(row) || mayHaveDelivered(row)) {
        return { event: "cancel-requested", next: { cancel_requested_at: now } };
      }
      return {
        event: "canceled",
        next: { cancel_requested_at: now, state: "canceled", terminal_at: now },
      };
    });
  }

  /** The record as this participant may see it, or null if it has none. */
  get(actor: ExchangeActor, key: ExchangeKey): ExchangeRecord | null {
    return this.read((sqlite) => {
      const row = this.selectByKey(sqlite, key.senderId, key.messageId);
      return row && this.canSee(actor, row) ? toRecord(row) : null;
    });
  }

  /**
   * This participant's records whose revision is past `cursor`, oldest change
   * first, each at its latest state. A cursor older than a purge gets
   * `reset: true` and a listing from the beginning, so a removal is never
   * silently skipped.
   */
  listChangesSince(actor: ExchangeActor, cursor: number, limit = 100): ExchangeChanges {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw refuse("VALIDATION", "Exchange cursor must be a non-negative integer");
    }
    const pageSize = requireLimit(limit);
    return this.read((sqlite) => {
      const clock = this.readClock(sqlite);
      const reset = cursor < clock.min_cursor;
      const from = reset ? 0 : cursor;
      const rows =
        actor.kind === "sender"
          ? (this.statement(
              sqlite,
              "SELECT * FROM assistant_exchanges WHERE sender_id = ? AND revision > ? ORDER BY revision LIMIT ?"
            ).all(actor.senderId, from, pageSize + 1) as ExchangeRow[])
          : (this.statement(
              sqlite,
              "SELECT * FROM assistant_exchanges WHERE receiver_host_id = ? AND receiver_lane_id = ? AND enrollment_generation = ? AND revision > ? ORDER BY revision LIMIT ?"
            ).all(
              actor.hostId,
              actor.laneId,
              actor.enrollmentGeneration,
              from,
              pageSize + 1
            ) as ExchangeRow[]);
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
   * Expires live records past their TTL into tombstones (a live exchange
   * fails with outcome `expired`), purges tombstones past their retention and
   * drops old audit rows. Bounded per call; `hasMore` asks for another.
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

  private transition(
    actor: ExchangeActor,
    key: ExchangeKey,
    decide: (row: ExchangeRow) => { event: ExchangeEvent; next: Partial<ExchangeRow> } | null
  ): ExchangeRecord {
    return this.write((sqlite) => {
      const row = this.selectByKey(sqlite, key.senderId, key.messageId);
      if (!row || !this.canSee(actor, row)) {
        throw refuse("NOT_FOUND", `No exchange ${key.messageId} for this participant`);
      }
      if (row.tombstoned_at !== null || row.expires_at <= this.now()) {
        throw refuse("VALIDATION", `Exchange ${row.message_id} has expired`);
      }
      const change = decide(row);
      if (!change) return toRecord(row);
      return toRecord(this.apply(sqlite, row, change.event, change.next, this.now()));
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

  /**
   * OpenTelemetry GenAI attribute names where the conventions define one;
   * ids, sizes, digests, outcome and latency have none, so they sit under
   * `daintree.exchange.*`. Built from an allowlist: no body, no free text.
   */
  private audit(
    sqlite: Database.Database,
    row: ExchangeRow,
    event: ExchangeEvent,
    previousState: ExchangeState | null,
    now: number
  ): void {
    const revision = event === "purged" ? this.nextRevision(sqlite) : row.revision;
    const attributes: Record<string, string | number> = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": row.receiver_lane_id,
      "gen_ai.conversation.id": row.context_id,
      "daintree.exchange.event": event,
      "daintree.exchange.message_id": row.message_id,
      "daintree.exchange.task_id": row.task_id,
      "daintree.exchange.sender_id": row.sender_id,
      "daintree.exchange.receiver_host_id": row.receiver_host_id,
      "daintree.exchange.receiver_lane_id": row.receiver_lane_id,
      "daintree.exchange.enrollment_generation": row.enrollment_generation,
      "daintree.exchange.revision": revision,
      "daintree.exchange.state": row.state,
      "daintree.exchange.outcome": row.outcome ?? row.state,
      "daintree.exchange.body_digest": row.body_digest,
      "daintree.exchange.body_bytes": row.body_bytes,
      "daintree.exchange.latency_ms": Math.max(0, now - row.created_at),
    };
    if (previousState !== null) attributes["daintree.exchange.previous_state"] = previousState;
    if (row.reply_digest !== null) attributes["daintree.exchange.reply_digest"] = row.reply_digest;
    if (row.reply_bytes !== null) attributes["daintree.exchange.reply_bytes"] = row.reply_bytes;
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

  private canSee(actor: ExchangeActor, row: ExchangeRow): boolean {
    if (actor.kind === "sender") return row.sender_id === actor.senderId;
    return (
      row.receiver_host_id === actor.hostId &&
      row.receiver_lane_id === actor.laneId &&
      row.enrollment_generation === actor.enrollmentGeneration
    );
  }

  private selectByKey(
    sqlite: Database.Database,
    senderId: string,
    messageId: string
  ): ExchangeRow | undefined {
    return this.statement(
      sqlite,
      "SELECT * FROM assistant_exchanges WHERE sender_id = ? AND message_id = ?"
    ).get(senderId, messageId) as ExchangeRow | undefined;
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

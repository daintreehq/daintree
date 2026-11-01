import type Database from "better-sqlite3";
import type {
  AuditEntry,
  InboundEvent,
  InjectionIntent,
  LocalStore,
  OutboxItem,
  QuestionOrigin,
  QuestionRow,
} from "@daintreehq/decisions-client";
import { getWritesSuppressed } from "../diskPressureState.js";
import { withDiskRecovery } from "../persistence/db.js";

/** Every table the store keeps. */
const DECISIONS_TABLES = [
  "decisions_outbox",
  "decisions_injection_intents",
  "decisions_inbound_events",
  "decisions_audit",
  "decisions_questions",
  "decisions_meta",
] as const;

/** The most calls one transaction runs, so a burst can't hold the main thread in one long commit. */
export const DECISIONS_STORE_MAX_BATCH = 256;

export type DecisionsStoreUnavailableReason = "disk-pressure" | "storage-fault" | "closed";

/** A call the store refused. Nothing it carried was stored. */
export class DecisionsStoreUnavailableError extends Error {
  constructor(
    readonly reason: DecisionsStoreUnavailableReason,
    options?: { cause?: unknown }
  ) {
    super(
      reason === "disk-pressure"
        ? "Decisions can't save while disk space is critical"
        : reason === "closed"
          ? "The Decisions store is closed"
          : "Decisions stopped saving after a storage error",
      options
    );
    this.name = "DecisionsStoreUnavailableError";
  }
}

type OpKind = "read" | "write";

interface Op {
  kind: OpKind;
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * A failure of the database rather than of the call: disk full, I/O,
 * corruption, a closed connection. A constraint (a duplicate question) is the
 * call's own failure and leaves the store usable.
 */
function isStorageFault(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return code.startsWith("SQLITE_") && !code.startsWith("SQLITE_CONSTRAINT");
  }
  return error instanceof TypeError && /database connection is not open/i.test(error.message);
}

interface QuestionRecord {
  question_id: string;
  alias: number;
  origin_host_id: string;
  pane_id: string;
  terminal_generation: number;
  ownership_principal: string;
  agent_incarnation: string;
  agent_kind: string;
  agent_session_id: string | null;
  project_id: string;
  worktree_id: string;
  worktree_root: string;
  workflow_gate_id: string | null;
  project_label: string | null;
  machine_label: string | null;
  requirement: string;
  question_revision: number;
  remote_event_seq: number | null;
  origin_created_at: string;
  expires_at: string | null;
  local_status: string;
  delivery_status: string;
  last_injection_id: string | null;
  last_attempt_at: string | null;
  agent_resume_strategy: string | null;
  error_code: string | null;
  content_sealed: string | null;
  answers_json: string;
  history_only: number;
  delivered_revision: number;
  attachment_digests: string;
}

const QUESTION_COLUMNS = [
  "question_id",
  "alias",
  "origin_host_id",
  "pane_id",
  "terminal_generation",
  "ownership_principal",
  "agent_incarnation",
  "agent_kind",
  "agent_session_id",
  "project_id",
  "worktree_id",
  "worktree_root",
  "workflow_gate_id",
  "project_label",
  "machine_label",
  "requirement",
  "question_revision",
  "remote_event_seq",
  "origin_created_at",
  "expires_at",
  "local_status",
  "delivery_status",
  "last_injection_id",
  "last_attempt_at",
  "agent_resume_strategy",
  "error_code",
  "content_sealed",
  "answers_json",
  "history_only",
  "delivered_revision",
  "attachment_digests",
] as const satisfies readonly (keyof QuestionRecord)[];

const INSERT_QUESTION = `INSERT INTO decisions_questions (${QUESTION_COLUMNS.join(", ")})
  VALUES (${QUESTION_COLUMNS.map((c) => `@${c}`).join(", ")})`;
const UPDATE_QUESTION = `UPDATE decisions_questions
  SET ${QUESTION_COLUMNS.filter((c) => c !== "question_id")
    .map((c) => `${c} = @${c}`)
    .join(", ")}
  WHERE question_id = @question_id`;

function toRecord(q: QuestionRow): QuestionRecord {
  return {
    question_id: q.question_id,
    alias: q.alias,
    origin_host_id: q.origin.host_id,
    pane_id: q.origin.pane_id,
    terminal_generation: q.origin.terminal_generation,
    ownership_principal: q.origin.ownership_principal,
    agent_incarnation: q.origin.agent_incarnation,
    agent_kind: q.origin.agent_kind,
    agent_session_id: q.origin.agent_session_id,
    project_id: q.origin.project_id,
    worktree_id: q.origin.worktree_id,
    worktree_root: q.origin.worktree_root,
    workflow_gate_id: q.origin.workflow_gate_id,
    project_label: q.origin.project_label ?? null,
    machine_label: q.origin.machine_label ?? null,
    requirement: q.requirement,
    question_revision: q.question_revision,
    remote_event_seq: q.remote_event_seq,
    origin_created_at: q.origin_created_at,
    expires_at: q.expires_at,
    local_status: q.local_status,
    delivery_status: q.delivery_status,
    last_injection_id: q.last_injection_id,
    last_attempt_at: q.last_attempt_at,
    agent_resume_strategy: q.agent_resume_strategy,
    error_code: q.error_code,
    content_sealed: q.content_sealed,
    answers_json: q.answers_json,
    history_only: q.history_only ? 1 : 0,
    delivered_revision: q.delivered_revision,
    attachment_digests: JSON.stringify(q.attachment_digests),
  };
}

function fromRecord(r: QuestionRecord): QuestionRow {
  const origin: QuestionOrigin = {
    host_id: r.origin_host_id,
    pane_id: r.pane_id,
    terminal_generation: Number(r.terminal_generation),
    ownership_principal: r.ownership_principal,
    agent_incarnation: r.agent_incarnation,
    agent_kind: r.agent_kind,
    agent_session_id: r.agent_session_id ?? null,
    project_id: r.project_id,
    worktree_id: r.worktree_id,
    worktree_root: r.worktree_root,
    workflow_gate_id: r.workflow_gate_id ?? null,
    ...(r.project_label != null ? { project_label: r.project_label } : {}),
    ...(r.machine_label != null ? { machine_label: r.machine_label } : {}),
  };
  return {
    question_id: r.question_id,
    alias: Number(r.alias),
    origin,
    requirement: r.requirement as QuestionRow["requirement"],
    question_revision: Number(r.question_revision),
    remote_event_seq: r.remote_event_seq == null ? null : Number(r.remote_event_seq),
    origin_created_at: r.origin_created_at,
    expires_at: r.expires_at ?? null,
    local_status: r.local_status as QuestionRow["local_status"],
    delivery_status: r.delivery_status as QuestionRow["delivery_status"],
    last_injection_id: r.last_injection_id ?? null,
    last_attempt_at: r.last_attempt_at ?? null,
    agent_resume_strategy: r.agent_resume_strategy ?? null,
    error_code: r.error_code ?? null,
    content_sealed: r.content_sealed ?? null,
    answers_json: r.answers_json,
    history_only: Number(r.history_only) === 1,
    delivered_revision: Number(r.delivered_revision),
    attachment_digests: JSON.parse(r.attachment_digests) as string[],
  };
}

/**
 * The store has no column for plaintext content: the library writes only
 * sealed content, and clears the legacy field with null.
 */
function assertNoLegacyContent(value: { legacy_content_json?: string | null }): void {
  if (value.legacy_content_json != null) {
    throw new Error("Decisions stores question content sealed only");
  }
}

/** A detached copy of a question patch, so a caller changing its object later can't change the write. */
function copyQuestionPatch(patch: Partial<QuestionRow>): Partial<QuestionRow> {
  assertNoLegacyContent(patch);
  const { legacy_content_json: _legacy, ...rest } = patch;
  const copy: Partial<QuestionRow> = { ...rest };
  if (patch.origin) copy.origin = { ...patch.origin };
  if (patch.attachment_digests) copy.attachment_digests = [...patch.attachment_digests];
  return copy;
}

interface OutboxRecord {
  id: string;
  kind: string;
  question_id: string;
  payload: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  last_error: string | null;
}

function toOutboxRecord(i: OutboxItem): OutboxRecord {
  return {
    id: i.id,
    kind: i.kind,
    question_id: i.question_id,
    payload: JSON.stringify(i.payload),
    attempts: i.attempts,
    next_attempt_at: i.next_attempt_at,
    created_at: i.created_at,
    last_error: i.last_error,
  };
}

function outboxFrom(r: OutboxRecord): OutboxItem {
  return {
    id: r.id,
    kind: r.kind as OutboxItem["kind"],
    question_id: r.question_id,
    payload: JSON.parse(r.payload) as unknown,
    attempts: Number(r.attempts),
    next_attempt_at: Number(r.next_attempt_at),
    created_at: Number(r.created_at),
    last_error: r.last_error ?? null,
  };
}

function eventFrom(r: InboundEvent): InboundEvent {
  return {
    seq: Number(r.seq),
    event_id: r.event_id,
    event_type: r.event_type,
    json: r.json,
    received_at: Number(r.received_at),
    processed_at: r.processed_at == null ? null : Number(r.processed_at),
  };
}

function intentFrom(r: InjectionIntent): InjectionIntent {
  return {
    injection_id: r.injection_id,
    question_id: r.question_id,
    answer_revision: Number(r.answer_revision),
    host_id: r.host_id,
    pane_id: r.pane_id,
    terminal_generation: Number(r.terminal_generation),
    ownership_principal: r.ownership_principal,
    agent_incarnation: r.agent_incarnation,
    state: r.state,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

/**
 * Deletes everything Decisions has stored, in one transaction, leaving the
 * rest of the app database alone. For the Data → delete action (#16025): run
 * it with the store closed, or calls still queued in it would write rows back.
 */
export function eraseDecisionsData(sqlite: Database.Database): void {
  if (getWritesSuppressed()) throw new DecisionsStoreUnavailableError("disk-pressure");
  withDiskRecovery(sqlite, () =>
    sqlite.transaction(() => {
      for (const table of DECISIONS_TABLES) sqlite.prepare(`DELETE FROM ${table}`).run();
      sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'decisions_audit'").run();
    })()
  );
}

/**
 * The client library's `LocalStore` over the app database (#16002). It
 * borrows the shared connection and never closes it.
 *
 * Calls queue in the order they are made and run together on the next turn
 * of the event loop, in one transaction, each inside its own savepoint: a
 * call that fails (a duplicate question) rolls back alone, and no call
 * resolves before the transaction holding it has committed. Concurrent
 * callers and bursts share one commit. Calls the library awaits one after
 * another (a relay frame is stored, then acknowledged) still commit one at a
 * time, since resolving any sooner would acknowledge what isn't on disk. A
 * read with nothing queued ahead of it runs at once.
 *
 * A transaction with writes in it commits with `synchronous = FULL`, as the
 * library requires (an injection intent is on disk before the terminal is
 * touched); the connection's own setting is put back straight after, so the
 * rest of the app keeps its cheaper commits.
 *
 * While disk space is critical, writes are refused, never dropped: a
 * question is either committed or its caller is told it wasn't. The first
 * refused write, or any storage error, stops this store writing for good, so
 * a library step that failed can't be followed by one that records it as
 * done (an event marked processed after its answer wasn't saved). Reads keep
 * working; the next enabled lifetime opens a fresh store.
 */
export class DaintreeLocalStore implements LocalStore {
  readonly durable = true;

  private queue: Op[] = [];
  private scheduled: NodeJS.Immediate | null = null;
  private closed = false;
  private fault: DecisionsStoreUnavailableError | null = null;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(private readonly sqlite: Database.Database) {}

  /** True once a refused write or a storage error has stopped this store writing. */
  isFaulted(): boolean {
    return this.fault !== null;
  }

  getMeta(key: string): Promise<string | null> {
    return this.enqueue("read", () => this.readMeta(key));
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.enqueue("write", () => this.writeMeta(key, value));
  }

  nextAlias(): Promise<number> {
    return this.enqueue("write", () => {
      const next = Number(this.readMeta("alias") ?? "0") + 1;
      this.writeMeta("alias", String(next));
      return next;
    });
  }

  commitNewQuestion(row: QuestionRow, outbox: OutboxItem): Promise<void> {
    return this.enqueueWith("write", () => {
      assertNoLegacyContent(row);
      const question = toRecord(row);
      const item = toOutboxRecord(outbox);
      return () => {
        this.st(INSERT_QUESTION).run(question);
        this.writeOutbox(item);
      };
    });
  }

  getQuestion(id: string): Promise<QuestionRow | null> {
    return this.enqueue("read", () => this.readQuestion(id));
  }

  updateQuestion(id: string, patch: Partial<QuestionRow>): Promise<QuestionRow | null> {
    return this.enqueueWith("write", () => {
      const copy = copyQuestionPatch(patch);
      return () => this.patchQuestion(id, copy);
    });
  }

  listQuestions(
    filter: { status?: QuestionRow["local_status"][]; paneId?: string } = {}
  ): Promise<QuestionRow[]> {
    const status = filter.status ? [...filter.status] : undefined;
    const paneId = filter.paneId;
    return this.enqueue("read", () =>
      (this.st("SELECT * FROM decisions_questions ORDER BY alias ASC").all() as QuestionRecord[])
        .map(fromRecord)
        .filter((q) => !status || status.includes(q.local_status))
        .filter((q) => !paneId || q.origin.pane_id === paneId)
    );
  }

  countOpenForPane(hostId: string, paneId: string): Promise<number> {
    return this.enqueue("read", () => {
      const r = this.st(
        `SELECT COUNT(*) AS n FROM decisions_questions
         WHERE origin_host_id = ? AND pane_id = ? AND local_status IN ('queued', 'open')`
      ).get(hostId, paneId) as { n: number };
      return Number(r.n);
    });
  }

  putOutbox(item: OutboxItem): Promise<void> {
    return this.enqueueWith("write", () => {
      const record = toOutboxRecord(item);
      return () => this.writeOutbox(record);
    });
  }

  dueOutbox(now: number, limit: number): Promise<OutboxItem[]> {
    return this.enqueue("read", () =>
      (
        this.st(
          `SELECT * FROM decisions_outbox WHERE next_attempt_at <= ?
           ORDER BY created_at ASC LIMIT ?`
        ).all(now, limit) as OutboxRecord[]
      ).map(outboxFrom)
    );
  }

  recordOutboxFailure(id: string, error: string, nextAttemptAt: number): Promise<void> {
    return this.enqueue("write", () => {
      this.st(
        `UPDATE decisions_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
         WHERE id = ?`
      ).run(error, nextAttemptAt, id);
    });
  }

  deleteOutbox(id: string): Promise<void> {
    return this.enqueue("write", () => {
      this.st("DELETE FROM decisions_outbox WHERE id = ?").run(id);
    });
  }

  outboxFor(questionId: string): Promise<OutboxItem[]> {
    return this.enqueue("read", () =>
      (
        this.st(
          "SELECT * FROM decisions_outbox WHERE question_id = ? ORDER BY created_at ASC"
        ).all(questionId) as OutboxRecord[]
      ).map(outboxFrom)
    );
  }

  insertEvent(ev: InboundEvent): Promise<boolean> {
    const event = eventFrom(ev);
    return this.enqueue("write", () => {
      const r = this.st(
        `INSERT OR IGNORE INTO decisions_inbound_events
           (seq, event_id, event_type, json, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        event.seq,
        event.event_id,
        event.event_type,
        event.json,
        event.received_at,
        event.processed_at
      );
      return r.changes === 1;
    });
  }

  markEventProcessed(seq: number, at: number): Promise<void> {
    return this.enqueue("write", () => {
      this.st("UPDATE decisions_inbound_events SET processed_at = ? WHERE seq = ?").run(at, seq);
    });
  }

  unprocessedEvents(limit: number): Promise<InboundEvent[]> {
    return this.enqueue("read", () =>
      (
        this.st(
          `SELECT * FROM decisions_inbound_events WHERE processed_at IS NULL
           ORDER BY seq ASC LIMIT ?`
        ).all(limit) as InboundEvent[]
      ).map(eventFrom)
    );
  }

  advanceCursor(): Promise<number> {
    return this.enqueue("write", () => {
      const has = this.st("SELECT 1 FROM decisions_inbound_events WHERE seq = ?");
      let cursor = this.readCursor();
      while (has.get(cursor + 1)) cursor++;
      this.writeMeta("cursor", String(cursor));
      return cursor;
    });
  }

  getCursor(): Promise<number> {
    return this.enqueue("read", () => this.readCursor());
  }

  forceCursor(seq: number): Promise<void> {
    return this.enqueue("write", () => {
      if (seq > this.readCursor()) this.writeMeta("cursor", String(seq));
    });
  }

  putIntent(i: InjectionIntent): Promise<void> {
    const intent = { ...i };
    return this.enqueue("write", () => this.writeIntent(intent));
  }

  updateIntent(id: string, patch: Partial<InjectionIntent>): Promise<InjectionIntent | null> {
    const copy = { ...patch };
    return this.enqueue("write", () => {
      const current = this.readIntent(id);
      if (!current) return null;
      const next = { ...current, ...copy };
      this.writeIntent(next);
      return next;
    });
  }

  getIntent(id: string): Promise<InjectionIntent | null> {
    return this.enqueue("read", () => this.readIntent(id));
  }

  openIntents(): Promise<InjectionIntent[]> {
    return this.enqueue("read", () =>
      (
        this.st(
          `SELECT * FROM decisions_injection_intents WHERE state IN ('intent', 'typed')
           ORDER BY created_at ASC, injection_id ASC`
        ).all() as InjectionIntent[]
      ).map(intentFrom)
    );
  }

  hasUncertainIntent(questionId: string): Promise<boolean> {
    return this.enqueue("read", () => {
      const r = this.st(
        `SELECT 1 FROM decisions_injection_intents
         WHERE question_id = ? AND state = 'uncertain' LIMIT 1`
      ).get(questionId);
      return r !== undefined;
    });
  }

  settleIntent(
    intentId: string,
    intentPatch: Partial<InjectionIntent>,
    questionId: string,
    questionPatch: Partial<QuestionRow>
  ): Promise<void> {
    return this.enqueueWith("write", () => {
      const intentCopy = { ...intentPatch };
      const questionCopy = copyQuestionPatch(questionPatch);
      return () => {
        const current = this.readIntent(intentId);
        if (current) this.writeIntent({ ...current, ...intentCopy });
        this.patchQuestion(questionId, questionCopy);
      };
    });
  }

  appendAudit(e: AuditEntry): Promise<void> {
    return this.enqueueWith("write", () => {
      const at = e.at;
      const json = JSON.stringify(e);
      return () => {
        this.st("INSERT INTO decisions_audit (at, json) VALUES (?, ?)").run(at, json);
      };
    });
  }

  listAudit(limit: number): Promise<AuditEntry[]> {
    return this.enqueue("read", () =>
      (
        this.st("SELECT json FROM decisions_audit ORDER BY id DESC LIMIT ?").all(limit) as {
          json: string;
        }[]
      )
        .map((r) => JSON.parse(r.json) as AuditEntry)
        .reverse()
    );
  }

  /**
   * Settles every call already queued (committing what can be), then refuses
   * every later one. The shared connection stays open.
   */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.flush(true);
      this.statements.clear();
    }
    return Promise.resolve();
  }

  /** Queues `run`; the inputs it needs must already be copied out of the caller's objects. */
  private enqueue<T>(kind: OpKind, run: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new DecisionsStoreUnavailableError("closed"));
    if (kind === "read" && this.queue.length === 0) {
      try {
        return Promise.resolve(run());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ kind, run, resolve: resolve as (value: unknown) => void, reject });
      this.scheduled ??= setImmediate(() => this.flush(false));
    });
  }

  /** Like `enqueue`, with `prepare` copying the caller's inputs now; it may throw to refuse the call. */
  private enqueueWith<T>(kind: OpKind, prepare: () => () => T): Promise<T> {
    let run: () => T;
    try {
      run = prepare();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(kind, run);
  }

  private flush(drainAll: boolean): void {
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = null;
    }
    do {
      const ops = this.queue.splice(0, DECISIONS_STORE_MAX_BATCH);
      if (ops.length === 0) return;
      const outcomes = this.runBatch(ops);
      ops.forEach((op, i) => {
        const outcome = outcomes[i];
        if (outcome.ok) op.resolve(outcome.value);
        else op.reject(outcome.error);
      });
    } while (drainAll);
    if (this.queue.length > 0) this.scheduled = setImmediate(() => this.flush(false));
  }

  private runBatch(ops: Op[]): Outcome[] {
    if (!this.fault && getWritesSuppressed() && ops.some((op) => op.kind === "write")) {
      this.fault = new DecisionsStoreUnavailableError("disk-pressure");
    }
    const outcomes = new Array<Outcome>(ops.length);
    const runnable: number[] = [];
    ops.forEach((op, i) => {
      if (op.kind === "write" && this.fault) outcomes[i] = { ok: false, error: this.fault };
      else runnable.push(i);
    });
    if (runnable.length === 0) return outcomes;

    const writes = runnable.some((i) => ops[i].kind === "write");
    try {
      const { results, fault } = this.withCommitLevel(writes, () =>
        withDiskRecovery(this.sqlite, () => this.runTransaction(runnable.map((i) => ops[i])))
      );
      runnable.forEach((opIndex, j) => {
        outcomes[opIndex] = results[j];
      });
      if (fault) this.fault ??= this.storageFault(fault);
    } catch (error) {
      // The batch rolled back whole: nothing in it was stored.
      const refused = writes ? this.storageFault(error) : error;
      if (writes) this.fault ??= refused as DecisionsStoreUnavailableError;
      for (const i of runnable) outcomes[i] = { ok: false, error: refused };
    }
    return outcomes;
  }

  private runTransaction(ops: Op[]): { results: Outcome[]; fault: unknown } {
    return this.sqlite.transaction(() => {
      let fault: unknown = null;
      const results = ops.map((op): Outcome => {
        // A write after a storage error in the same batch must not commit
        // without the one that failed.
        if (op.kind === "write" && fault !== null) {
          return { ok: false, error: this.storageFault(fault) };
        }
        try {
          return { ok: true, value: this.sqlite.transaction(op.run)() };
        } catch (error) {
          // SQLite ends the whole transaction itself on some I/O errors;
          // carrying on would run the rest outside any transaction.
          if (!this.sqlite.inTransaction) throw error;
          if (!isStorageFault(error)) return { ok: false, error };
          fault = error;
          return { ok: false, error: this.storageFault(error) };
        }
      });
      return { results, fault };
    })();
  }

  private withCommitLevel<T>(writes: boolean, fn: () => T): T {
    if (!writes) return fn();
    const previous = Number(this.sqlite.pragma("synchronous", { simple: true }));
    this.sqlite.pragma("synchronous = FULL");
    try {
      return fn();
    } finally {
      try {
        this.sqlite.pragma(`synchronous = ${previous}`);
      } catch (error) {
        console.warn("[Decisions] Couldn't restore the database's commit level:", error);
      }
    }
  }

  private storageFault(cause: unknown): DecisionsStoreUnavailableError {
    return cause instanceof DecisionsStoreUnavailableError
      ? cause
      : new DecisionsStoreUnavailableError("storage-fault", { cause });
  }

  private st(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.sqlite.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private readMeta(key: string): string | null {
    const r = this.st("SELECT value FROM decisions_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r ? r.value : null;
  }

  private writeMeta(key: string, value: string): void {
    this.st(
      `INSERT INTO decisions_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  private readCursor(): number {
    return Number(this.readMeta("cursor") ?? "0");
  }

  private readQuestion(id: string): QuestionRow | null {
    const r = this.st("SELECT * FROM decisions_questions WHERE question_id = ?").get(id) as
      | QuestionRecord
      | undefined;
    return r ? fromRecord(r) : null;
  }

  private patchQuestion(id: string, patch: Partial<QuestionRow>): QuestionRow | null {
    const current = this.readQuestion(id);
    if (!current) return null;
    const next: QuestionRow = {
      ...current,
      ...patch,
      question_id: current.question_id,
      origin: { ...current.origin, ...(patch.origin ?? {}) },
    };
    this.st(UPDATE_QUESTION).run(toRecord(next));
    return next;
  }

  private writeOutbox(record: OutboxRecord): void {
    this.st(
      `INSERT INTO decisions_outbox
         (id, kind, question_id, payload, attempts, next_attempt_at, created_at, last_error)
       VALUES (@id, @kind, @question_id, @payload, @attempts, @next_attempt_at, @created_at, @last_error)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload,
         next_attempt_at = excluded.next_attempt_at`
    ).run(record);
  }

  private readIntent(id: string): InjectionIntent | null {
    const r = this.st("SELECT * FROM decisions_injection_intents WHERE injection_id = ?").get(
      id
    ) as InjectionIntent | undefined;
    return r ? intentFrom(r) : null;
  }

  private writeIntent(i: InjectionIntent): void {
    this.st(
      `INSERT OR REPLACE INTO decisions_injection_intents
         (injection_id, question_id, answer_revision, host_id, pane_id, terminal_generation,
          ownership_principal, agent_incarnation, state, created_at, updated_at)
       VALUES (@injection_id, @question_id, @answer_revision, @host_id, @pane_id,
         @terminal_generation, @ownership_principal, @agent_incarnation, @state, @created_at,
         @updated_at)`
    ).run(intentFrom(i));
  }
}

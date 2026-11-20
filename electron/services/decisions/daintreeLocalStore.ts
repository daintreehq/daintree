import type Database from "better-sqlite3";
import {
  STORE_FORMAT_KEY,
  checkStoreFormat,
  isPendingMessage,
  parseAnswers,
  parseMessages,
  unreportedStatuses,
  type AuditEntry,
  type InboundEvent,
  type InjectionIntent,
  type LocalStore,
  type OutboxItem,
  type QuestionOrigin,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import { getWritesSuppressed } from "../diskPressureState.js";
import { withDiskRecovery } from "../persistence/db.js";
import { logWarn } from "../../utils/logger.js";
import type { QueuedClosing } from "./paneDecisionState.js";
import {
  noticeAttemptOf,
  noticeTrailOf,
  noticeUntypedOf,
  type SettledIntent,
} from "./noticeTrail.js";
import { HANDLED_ANSWERS_META_KEY, parseHandledAnswers } from "./attentionList.js";
import {
  QUESTION_MARKS_META_KEY,
  parseQuestionMarks,
  serializeQuestionMarks,
} from "./questionMarks.js";
import { removableFromHistory } from "./questionList.js";
import { SNAPSHOTS_SHARED_META_KEY, sharedRecord } from "./snapshotsShared.js";

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

/**
 * `disk-pressure`: refused while disk space was critical. `disk-full`: the
 * database itself ran out of room (`SQLITE_FULL`), which a dip between two
 * disk-space checks can cause with the monitor never seeing it.
 * `storage-busy`: another connection held the database past the busy
 * timeout, or changed it under a read (`SQLITE_BUSY` and its extended codes).
 * `storage-fault`: any other failure of the database.
 */
export type DecisionsStoreUnavailableReason =
  "disk-pressure" | "disk-full" | "storage-busy" | "storage-fault" | "closed";

/** A call the store refused. Nothing it carried was stored. */
export class DecisionsStoreUnavailableError extends Error {
  constructor(
    readonly reason: DecisionsStoreUnavailableReason,
    options?: { cause?: unknown }
  ) {
    super(
      reason === "disk-pressure"
        ? "Decisions can't save while disk space is critical"
        : reason === "disk-full"
          ? "Decisions stopped saving because the disk was full"
          : reason === "storage-busy"
            ? "Decisions stopped saving because the database was busy"
            : reason === "closed"
              ? "The Decisions store is closed"
              : "Decisions stopped saving after a storage error",
      options
    );
    this.name = "DecisionsStoreUnavailableError";
  }
}

type OpKind = "read" | "write";

/** The outbox kinds `pendingClosings` reads. */
const CLOSING_KINDS: ReadonlySet<string> = new Set(["cancel", "owner-decline"]);

/**
 * What one committed transaction wrote that a reader of the store's rows
 * follows: the questions inserted, changed or removed, and the meta keys set.
 * Calls that failed, and transactions that rolled back, name nothing.
 */
export interface StoreCommit {
  questions: ReadonlySet<string>;
  meta: ReadonlySet<string>;
}

/** What a commit's calls wrote, gathered as they run. */
interface CommitChange {
  questions: Set<string>;
  meta: Set<string>;
}

function emptyChange(): CommitChange {
  return { questions: new Set(), meta: new Set() };
}

interface Op {
  kind: OpKind;
  /** A write refused on its own while disk space is critical, rather than stopping the store. */
  refusable?: boolean;
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Where a batch was when the database failed it, for the line saying the
 * store stopped (#16840): a busy at once and one after the whole busy
 * timeout read the same otherwise. `setup` is setting the commit level, and
 * `elapsedMs` how long that step had run, waiting included.
 */
interface FaultSite {
  step: "setup" | "begin" | "call" | "commit";
  writes: boolean;
  calls: number;
  elapsedMs: number;
}

/** The step a batch is in, and when it began; updated as the batch runs. */
interface BatchProgress {
  step: FaultSite["step"];
  since: number;
}

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

function isBusyCode(code: unknown): boolean {
  return typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

function elapsedSince(since: number): number {
  return Math.round(performance.now() - since);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The question fields a timeout notice's trail reads; a patch touching none of them can't move it. */
const TRAIL_FIELDS: readonly (keyof QuestionRow)[] = [
  "answers_json",
  "delivery_status",
  "error_code",
  "local_status",
  "question_revision",
  "expires_at",
  "history_only",
];

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
  messages_json: string;
  /** 1 while a follow-up waits to be typed or its receipt to be sent; derived, never read back. */
  messages_waiting: number;
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
  "messages_json",
  "messages_waiting",
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

/**
 * Whether delivery still has work in a question's follow-ups (#16231): one
 * waiting to be typed, or a receipt the relay hasn't taken, by the library's
 * own tests.
 */
function messagesWaiting(json: string): boolean {
  return parseMessages(json).some(
    (message) =>
      isPendingMessage(message) ||
      // A row holding other than what the library writes is stored as given, never refused.
      (message.delivery != null && unreportedStatuses(message.delivery).length > 0)
  );
}

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
    messages_json: q.messages_json,
    messages_waiting: messagesWaiting(q.messages_json) ? 1 : 0,
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
    messages_json: r.messages_json,
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
/**
 * A question cancelled stays cancelled when a flush that read its create
 * before the cancel dropped it then finds the ciphertext gone (#16014): the
 * library would record the create as refused for good, `publish-failed`,
 * though nothing was ever refused and the agent was told it was cancelled.
 */
function keepingCancelled(current: QuestionRow, patch: Partial<QuestionRow>): Partial<QuestionRow> {
  if (current.local_status !== "cancelled" || patch.local_status !== "publish-failed") return patch;
  const { local_status: _status, error_code: _code, ...rest } = patch;
  return rest;
}

/**
 * A create's receipt never takes a question back past a later event already
 * applied to it (#17234): when the relay commits a create and a phone's
 * decline or answer is applied before the create's response is read, as when
 * a lost response has the create sent again, the library would record the
 * question `open` at the create's older seq and clear the code a later
 * delivery recorded. A reopen is a later event, and still applies.
 */
function keepingLaterEvent(
  current: QuestionRow,
  patch: Partial<QuestionRow>
): Partial<QuestionRow> {
  if (
    patch.local_status === undefined ||
    patch.remote_event_seq == null ||
    current.remote_event_seq == null ||
    patch.remote_event_seq >= current.remote_event_seq
  ) {
    return patch;
  }
  const { local_status: _status, remote_event_seq: _seq, error_code: _code, ...rest } = patch;
  return rest;
}

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

/** The question a stored relay event names, or null when it names none. */
function eventQuestionOf(json: string): string | null {
  try {
    const questionId = (JSON.parse(json) as { question_id?: unknown } | null)?.question_id;
    return typeof questionId === "string" && questionId !== "" ? questionId : null;
  } catch {
    return null;
  }
}

/** A person's answer, decline or follow-up as the library records it in meta, by its key. */
interface PersonRecord {
  key: string;
  kind: "answer" | "decline" | "message";
  /** The answer's action id, the decline's, or the follow-up's message id. */
  id: string;
  questionId: string;
  /** The relay took it, so its event is still to come back. */
  sent: boolean;
}

function personRecordOf(key: string, value: string): PersonRecord | null {
  const at = key.indexOf(":");
  const prefix = key.slice(0, at);
  const kind =
    prefix === "owner-answer"
      ? "answer"
      : prefix === "owner-decline"
        ? "decline"
        : prefix === "owner-message"
          ? "message"
          : null;
  const id = key.slice(at + 1);
  if (kind === null || id === "") return null;
  try {
    const parsed = JSON.parse(value) as {
      question_id?: unknown;
      result?: { status?: unknown } | null;
    } | null;
    if (typeof parsed?.question_id !== "string") return null;
    return {
      key,
      kind,
      id,
      questionId: parsed.question_id,
      sent: parsed.result?.status === "sent",
    };
  } catch {
    return null;
  }
}

/** An answer or follow-up the relay took from this computer, by its id. */
interface Echo {
  kind: "answer" | "message";
  id: string;
}

/** The `echoes` the row doesn't hold yet. */
function echoesMissingFrom(row: QuestionRow, echoes: readonly Echo[] | undefined): Echo[] {
  if (echoes === undefined || echoes.length === 0) return [];
  let answers: Set<string> | null = null;
  let messages: Set<string> | null = null;
  return echoes.filter((echo) => {
    if (echo.kind === "answer") {
      answers ??= new Set(parseAnswers(row.answers_json).map((entry) => entry.entry_id));
      return !answers.has(echo.id);
    }
    messages ??= new Set(parseMessages(row.messages_json).map((message) => message.message_id));
    return !messages.has(echo.id);
  });
}

/** The agent's message a `message.published` audit entry names; null for any other entry. */
function publishedMessageOf(json: string): { questionId: string; messageId: string } | null {
  try {
    const entry = JSON.parse(json) as {
      event?: unknown;
      question_id?: unknown;
      detail?: { message_id?: unknown } | null;
    } | null;
    if (entry?.event !== "message.published") return null;
    const questionId = entry.question_id;
    const messageId = entry.detail?.message_id;
    return typeof questionId === "string" && typeof messageId === "string"
      ? { questionId, messageId }
      : null;
  } catch {
    return null;
  }
}

/** A relay event with only what names it kept; null for one that can't be read. */
function redactedEvent(json: string): string | null {
  try {
    const event = JSON.parse(json) as Record<string, unknown> | null;
    if (event === null || typeof event !== "object") return null;
    const kept: Record<string, unknown> = {};
    for (const field of ["seq", "event_id", "event_type", "question_id", "question_revision"]) {
      if (event[field] !== undefined) kept[field] = event[field];
    }
    return JSON.stringify(kept);
  } catch {
    return null;
  }
}

/**
 * The question a correlation pointer holds in force, as the library reads it:
 * the one staged when there is one, else the committed one; a plain id is a
 * committed one from before pointers were staged.
 */
function correlationInForce(value: string): string | null {
  if (!value.startsWith("{")) return value === "" ? null : value;
  try {
    const pointer = JSON.parse(value) as { q?: unknown; p?: unknown } | null;
    if (typeof pointer?.p === "string") return pointer.p;
    return typeof pointer?.q === "string" ? pointer.q : null;
  } catch {
    return null;
  }
}

/** The question a stored `decision.deleted` event names, or null when it names none. */
function deletedQuestionOf(json: string): string | null {
  try {
    const questionId = (JSON.parse(json) as { question_id?: unknown } | null)?.question_id;
    return typeof questionId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(questionId)
      ? questionId
      : null;
  } catch {
    return null;
  }
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
    message_id: r.message_id ?? null,
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

/** Runs `fn` with commits made durable at once, putting the connection's own level back after. */
function withFullSync<T>(sqlite: Database.Database, fn: () => T): T {
  const previous = Number(sqlite.pragma("synchronous", { simple: true }));
  sqlite.pragma("synchronous = FULL");
  try {
    return fn();
  } finally {
    try {
      sqlite.pragma(`synchronous = ${previous}`);
    } catch (error) {
      console.warn("[Decisions] Couldn't restore the database's commit level:", error);
    }
  }
}

/**
 * Deletes everything Decisions has stored, in one transaction, leaving the
 * rest of the app database alone. For the Data → delete action (#16025): run
 * it with the store closed, or calls still queued in it would write rows back.
 * It commits with `synchronous = FULL`, since a deletion that reports done
 * must survive a crash straight after.
 */
export function eraseDecisionsData(sqlite: Database.Database): void {
  if (getWritesSuppressed()) throw new DecisionsStoreUnavailableError("disk-pressure");
  withFullSync(sqlite, () =>
    withDiskRecovery(sqlite, () =>
      sqlite.transaction(() => {
        for (const table of DECISIONS_TABLES) sqlite.prepare(`DELETE FROM ${table}`).run();
        sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'decisions_audit'").run();
      })()
    )
  );
}

/** Whether any Decisions row is stored, in any of the store's tables. */
export function hasDecisionsData(sqlite: Database.Database): boolean {
  return DECISIONS_TABLES.some(
    (table) => sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined
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
 * working; the next enabled lifetime opens a fresh store, and so does the
 * service once a disk-space fault has room again (#16605) or a while after
 * the database was busy (#16840).
 */
export class DaintreeLocalStore implements LocalStore {
  readonly durable = true;

  private queue: Op[] = [];
  private scheduled: NodeJS.Immediate | null = null;
  private closed = false;
  private fault: DecisionsStoreUnavailableError | null = null;
  private readonly statements = new Map<string, Database.Statement>();
  /**
   * Creates this store deleted: published, cancelled before they ever were,
   * or refused. A flush holding a copy of one must never write it back.
   */
  private readonly deletedCreates = new Set<string>();
  private readonly commitListeners = new Set<(commit: StoreCommit) => void>();
  /** What the call running now has written; null outside a call. */
  private writing: CommitChange | null = null;
  private readonly deletionListeners = new Set<(questionId: string) => void>();
  private readonly faultListeners = new Set<(reason: DecisionsStoreUnavailableReason) => void>();

  constructor(private readonly sqlite: Database.Database) {}

  /**
   * Calls `listener` after each transaction that committed at least one
   * write, once per transaction, with the questions and meta keys it wrote.
   * It runs after the commit and must not throw back into it; nothing it does
   * can undo what was stored.
   */
  onCommit(listener: (commit: StoreCommit) => void): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  /**
   * Calls `listener` with a question's id once the relay's deletion of it
   * (`decision.deleted`) has been applied and that commit is on disk (#16233).
   */
  onQuestionDeleted(listener: (questionId: string) => void): () => void {
    this.deletionListeners.add(listener);
    return () => {
      this.deletionListeners.delete(listener);
    };
  }

  /**
   * Every question the relay deleted, as applied here: its `decision.deleted`
   * event processed and its row withdrawn. An event refused or never applied
   * (no row, history only) names nothing.
   */
  deletedQuestionIds(): Promise<ReadonlySet<string>> {
    return this.enqueue("read", () => {
      const events = this.st(
        `SELECT json FROM decisions_inbound_events
         WHERE event_type = 'decision.deleted' AND processed_at IS NOT NULL`
      ).all() as Array<{ json: string }>;
      const ids = new Set<string>();
      for (const { json } of events) {
        const questionId = deletedQuestionOf(json);
        if (questionId !== null && this.isWithdrawn(questionId)) ids.add(questionId);
      }
      return ids;
    });
  }

  /** True once a refused write or a storage error has stopped this store writing. */
  isFaulted(): boolean {
    return this.fault !== null;
  }

  /** Why this store stopped writing; null while it still writes. */
  faultReason(): DecisionsStoreUnavailableReason | null {
    return this.fault?.reason ?? null;
  }

  /**
   * Calls `listener` once, when this store stops writing, with why. It runs
   * inside the call that stopped it and must not call back into the store.
   */
  onFault(listener: (reason: DecisionsStoreUnavailableReason) => void): () => void {
    this.faultListeners.add(listener);
    return () => {
      this.faultListeners.delete(listener);
    };
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
        this.writing?.questions.add(question.question_id);
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
    return this.enqueue("read", () => {
      if (status?.length === 0) return [];
      // Filtered in SQL so settled history is never decoded; a status list
      // reads decisions_questions_status_idx.
      const where: string[] = [];
      const params: string[] = [];
      if (status) {
        where.push(`local_status IN (${status.map(() => "?").join(", ")})`);
        params.push(...status);
      }
      if (paneId) {
        where.push("pane_id = ?");
        params.push(paneId);
      }
      const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
      return (
        this.st(`SELECT * FROM decisions_questions${clause} ORDER BY alias ASC`).all(
          ...params
        ) as QuestionRecord[]
      ).map(fromRecord);
    });
  }

  /**
   * The rows of the questions `ids` names that are stored, in alias order,
   * read by primary key: what a reader following `onCommit` reads of a
   * commit, rather than every row.
   */
  getQuestions(ids: Iterable<string>): Promise<QuestionRow[]> {
    const list = JSON.stringify([...new Set(ids)]);
    return this.enqueue("read", () => {
      if (list === "[]") return [];
      return (
        this.st(
          `SELECT * FROM decisions_questions
           WHERE question_id IN (SELECT value FROM json_each(?))
           ORDER BY alias ASC`
        ).all(list) as QuestionRecord[]
      ).map(fromRecord);
    });
  }

  /**
   * Removes this computer's settled questions (#18033): every row its list
   * shows under History (`removableFromHistory`) that nothing still works on,
   * with its settled injection intents and the person's answer, decline and
   * follow-up records naming it, in one write. A question keeps its row while
   * anything is owed for it: an outbox item, an injection not yet acked or
   * abandoned, a follow-up or receipt waiting (`messages_waiting`), an event
   * not yet applied, a terminal snapshot the relay may still hold
   * (`SNAPSHOTS_SHARED_META_KEY`), a person's answer or follow-up the relay
   * took whose event hasn't come back yet, or one of `busy`, read as the
   * write runs. Handled answers and the person's marks lose the removed ids.
   * The audit log, the inbound ledger, the cursor and the library's own
   * bookkeeping stay. Sends nothing. Resolves with the ids removed.
   */
  removeSettledQuestions(hostId: string, busy: () => ReadonlySet<string>): Promise<string[]> {
    // Refused before it queues, and again as its batch begins: a person's removal never stops the store writing.
    if (getWritesSuppressed()) {
      return Promise.reject(new DecisionsStoreUnavailableError("disk-pressure"));
    }
    return this.enqueue("write", () => this.removeSettled(hostId, busy()), true);
  }

  private removeSettled(hostId: string, busy: ReadonlySet<string>): string[] {
    const handled = parseHandledAnswers(this.readMeta(HANDLED_ANSWERS_META_KEY));
    const owed = new Set<string>(sharedRecord(this.readMeta(SNAPSHOTS_SHARED_META_KEY)).keys());
    for (const id of busy) owed.add(id);
    const unapplied = this.st(
      "SELECT json FROM decisions_inbound_events WHERE processed_at IS NULL"
    ).all() as Array<{ json: string }>;
    for (const { json } of unapplied) {
      const id = eventQuestionOf(json);
      if (id !== null) owed.add(id);
    }
    const candidates = (
      this.st(
        `SELECT * FROM decisions_questions AS q
         WHERE q.origin_host_id = ? AND q.history_only = 0 AND q.messages_waiting = 0
           AND q.local_status IN
             ('human-answered', 'proxy-answered', 'cancelled', 'expired', 'publish-failed')
           AND NOT EXISTS (SELECT 1 FROM decisions_outbox AS o WHERE o.question_id = q.question_id)
           AND NOT EXISTS (
             SELECT 1 FROM decisions_injection_intents AS i
             WHERE i.question_id = q.question_id AND i.state NOT IN ('acked', 'abandoned'))
         ORDER BY q.alias ASC`
      ).all(hostId) as QuestionRecord[]
    ).map(fromRecord);
    if (candidates.length === 0) return [];
    const records = this.personRecords();
    const echoes = this.echoesOwed(records);
    const relayDeleted = this.relayDeletedIds();
    const removed = candidates
      .filter(
        (row) =>
          !owed.has(row.question_id) &&
          removableFromHistory(row, handled, hostId) &&
          // An event the relay took and hasn't sent back yet needs the row it lands on,
          // unless the relay deleted the question, which no event follows.
          !(
            this.awaitsEcho(row, echoes.get(row.question_id)) &&
            !(relayDeleted.has(row.question_id) && row.local_status === "cancelled")
          )
      )
      .map((row) => row.question_id);
    if (removed.length === 0) return removed;
    const gone = new Set(removed);
    for (const id of removed) {
      this.st("DELETE FROM decisions_injection_intents WHERE question_id = ?").run(id);
      this.st("DELETE FROM decisions_questions WHERE question_id = ?").run(id);
      this.writing?.questions.add(id);
    }
    // A person's records hold their signed answers and follow-ups, so they go with the question.
    for (const record of records) {
      if (gone.has(record.questionId)) this.deleteMeta(record.key);
    }
    this.redactEvents(removed);
    this.forgetCorrelations(gone);
    if ([...handled.keys()].some((id) => gone.has(id))) {
      const kept: Record<string, number> = {};
      for (const [id, revision] of handled) if (!gone.has(id)) kept[id] = revision;
      this.writeMeta(HANDLED_ANSWERS_META_KEY, JSON.stringify(kept));
    }
    const marks = parseQuestionMarks(this.readMeta(QUESTION_MARKS_META_KEY));
    let marked = false;
    for (const [key, mark] of marks) {
      if (mark.hostId === hostId && gone.has(mark.questionId)) {
        marks.delete(key);
        marked = true;
      }
    }
    if (marked) this.writeMeta(QUESTION_MARKS_META_KEY, serializeQuestionMarks(marks));
    return removed;
  }

  /**
   * By question, the answers and follow-ups the relay took from this computer:
   * the person's (their records say `sent`) and the agent's (published, by
   * the library's audit entry). Each is in its row only once its event is back.
   */
  private echoesOwed(records: readonly PersonRecord[]): Map<string, Echo[]> {
    const echoes = new Map<string, Echo[]>();
    const add = (questionId: string, echo: Echo) => {
      const list = echoes.get(questionId);
      if (list === undefined) echoes.set(questionId, [echo]);
      else list.push(echo);
    };
    for (const record of records) {
      if (record.sent && record.kind !== "decline") {
        add(record.questionId, { kind: record.kind, id: record.id });
      }
    }
    const published = this.st(
      `SELECT json FROM decisions_audit WHERE json LIKE '%"message.published"%'`
    ).all() as Array<{ json: string }>;
    for (const { json } of published) {
      const echo = publishedMessageOf(json);
      if (echo !== null) add(echo.questionId, { kind: "message", id: echo.messageId });
    }
    return echoes;
  }

  /**
   * Whether one of `echoes` hasn't come back: neither in the row nor named by
   * an event the inbox already processed about the question (one it couldn't
   * apply, a key missing, is back all the same and nothing more follows).
   */
  private awaitsEcho(row: QuestionRow, echoes: readonly Echo[] | undefined): boolean {
    const missing = echoesMissingFrom(row, echoes);
    if (missing.length === 0) return false;
    const processed = this.st(
      `SELECT json FROM decisions_inbound_events
       WHERE processed_at IS NOT NULL
         AND (CASE WHEN json_valid(json) THEN json_extract(json, '$.question_id') END) = ?`
    ).all(row.question_id) as Array<{ json: string }>;
    return missing.some((echo) => !processed.some(({ json }) => json.includes(echo.id)));
  }

  /** The questions a `decision.deleted` event the inbox applied names. */
  private relayDeletedIds(): Set<string> {
    const ids = new Set<string>();
    const events = this.st(
      `SELECT json FROM decisions_inbound_events
       WHERE event_type = 'decision.deleted' AND processed_at IS NOT NULL`
    ).all() as Array<{ json: string }>;
    for (const { json } of events) {
      const id = deletedQuestionOf(json);
      if (id !== null) ids.add(id);
    }
    return ids;
  }

  /**
   * Strips what the relay sent about removed questions from the events the
   * inbox already applied: their sealed questions, answers and follow-ups,
   * which this computer's keys still open. The ledger keeps each event's
   * seq, id, type, question and revision, all that deduplicating, the cursor
   * and a reopen's round check read.
   */
  private redactEvents(removed: readonly string[]): void {
    const events = this.st(
      `SELECT seq, json FROM decisions_inbound_events
       WHERE processed_at IS NOT NULL
         AND (CASE WHEN json_valid(json) THEN json_extract(json, '$.question_id') END)
           IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(removed)) as Array<{ seq: number; json: string }>;
    for (const { seq, json } of events) {
      const kept = redactedEvent(json);
      if (kept !== null) {
        this.st("UPDATE decisions_inbound_events SET json = ? WHERE seq = ?").run(kept, seq);
      }
    }
  }

  /**
   * Lets go of each correlation pointer whose question in force was removed,
   * so a retry under its id asks afresh rather than falling back to an older
   * question it superseded. One whose question in force stays is kept.
   */
  private forgetCorrelations(gone: ReadonlySet<string>): void {
    const pointers = this.st(
      "SELECT key, value FROM decisions_meta WHERE key > 'corr:' AND key < 'corr;'"
    ).all() as Array<{ key: string; value: string }>;
    for (const { key, value } of pointers) {
      const inForce = correlationInForce(value);
      if (inForce !== null && gone.has(inForce)) this.deleteMeta(key);
    }
  }

  private deleteMeta(key: string): void {
    this.st("DELETE FROM decisions_meta WHERE key = ?").run(key);
    this.writing?.meta.add(key);
  }

  /** The person's answer, decline and follow-up records the library keeps in meta, by the question each names. */
  private personRecords(): PersonRecord[] {
    const records: PersonRecord[] = [];
    const rows = this.st(
      `SELECT key, value FROM decisions_meta
       WHERE (key > 'owner-answer:' AND key < 'owner-answer;')
          OR (key > 'owner-decline:' AND key < 'owner-decline;')
          OR (key > 'owner-message:' AND key < 'owner-message;')`
    ).all() as Array<{ key: string; value: string }>;
    for (const { key, value } of rows) {
      const record = personRecordOf(key, value);
      if (record !== null) records.push(record);
    }
    return records;
  }

  /**
   * The questions asked on `hostId` by one of `agentKinds` whose origin names
   * no session yet, whatever their status, in alias order. For the agents
   * delivery resumes it reads decisions_questions_missing_session_idx, so
   * linked history is never read.
   */
  listSessionlessQuestions(hostId: string, agentKinds: readonly string[]): Promise<QuestionRow[]> {
    // Written into the query, sorted, rather than bound: SQLite uses a partial
    // index only for a query that spells out its predicate. Any other list
    // reads the same rows, without the index.
    const kinds = [...new Set(agentKinds)]
      .sort()
      .map((kind) => `'${kind.replaceAll("'", "''")}'`)
      .join(", ");
    return this.enqueue("read", () => {
      if (kinds === "") return [];
      return (
        this.st(
          `SELECT * FROM decisions_questions
           WHERE origin_host_id = ? AND agent_kind IN (${kinds})
             AND (agent_session_id IS NULL OR agent_session_id = '')
           ORDER BY alias ASC`
        ).all(hostId) as QuestionRecord[]
      ).map(fromRecord);
    });
  }

  /**
   * Whether any answer or follow-up waits to be typed, or a typed one to be
   * reported to the relay. Reads three partial indexes, so it costs next to
   * nothing when nothing waits. A person's decline (#17234) keeps its row
   * `desktop-received` after delivery drops its notice for a run that has
   * gone, so a cancelled row waits only while an entry is still to be typed;
   * entries it can't read are taken as waiting, and never fail the read.
   */
  hasPendingDelivery(): Promise<boolean> {
    return this.enqueue("read", () => {
      const waiting = this.st(
        `SELECT 1 FROM decisions_questions AS q
         WHERE delivery_status IN ('desktop-received', 'pending-host') AND history_only = 0
           AND CASE
             WHEN local_status <> 'cancelled' THEN 1
             WHEN NOT json_valid(answers_json) THEN 1
             WHEN json_type(answers_json) <> 'array' THEN 1
             ELSE EXISTS (
               SELECT 1 FROM json_each(q.answers_json) AS entry
               WHERE CASE
                 WHEN entry.type = 'object' THEN
                   json_extract(entry.value, '$.deliver') = 1
                   AND json_extract(entry.value, '$.delivered') = 0
                 ELSE 1
               END
             )
           END
         LIMIT 1`
      ).get();
      if (waiting !== undefined) return true;
      const followUps = this.st(
        `SELECT 1 FROM decisions_questions WHERE messages_waiting = 1 AND history_only = 0 LIMIT 1`
      ).get();
      if (followUps !== undefined) return true;
      const unreported = this.st(
        `SELECT 1 FROM decisions_injection_intents WHERE state IN ('intent', 'typed') LIMIT 1`
      ).get();
      return unreported !== undefined;
    });
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

  /**
   * A create deleted meanwhile is refused, never put back (#16014): a cancel
   * that dropped it as never published while a starting attempt was uploading
   * it would otherwise see it published after all. The refusal fails that
   * flush before it sends the create. Otherwise a create is written as given:
   * from 0.9.0 the publisher rewrites one only from the item as stored, under
   * the shared lock, and withdraws its own possibly-published claim from a
   * create the relay showed it never took.
   */
  putOutbox(item: OutboxItem): Promise<void> {
    return this.enqueueWith("write", () => {
      const record = toOutboxRecord(item);
      return () => {
        if (record.kind === "create") this.refuseDeletedCreate(record);
        this.writeOutbox(record);
      };
    });
  }

  /**
   * Every attachment id a pending create names, whatever its question's state,
   * retry time or upload progress: the spool entries still owed to the relay.
   * Throws on a create it can't read, so a sweep deletes nothing then.
   */
  referencedAttachmentIds(): Promise<Set<string>> {
    return this.enqueue("read", () => {
      const ids = new Set<string>();
      const rows = this.st("SELECT payload FROM decisions_outbox WHERE kind = 'create'").all() as {
        payload: string;
      }[];
      for (const { payload } of rows) {
        const parsed = JSON.parse(payload) as { attachments?: unknown } | null;
        // The library writes `attachments: []` on every create; one without is unreadable.
        const attachments = typeof parsed === "object" ? parsed?.attachments : undefined;
        if (!Array.isArray(attachments)) {
          throw new Error("A pending create's attachments are unreadable");
        }
        for (const attachment of attachments as { attachment_id?: unknown }[]) {
          if (typeof attachment?.attachment_id !== "string") {
            throw new Error("A pending create names an unreadable attachment");
          }
          ids.add(attachment.attachment_id);
        }
      }
      return ids;
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
      const r = this.st(
        "DELETE FROM decisions_outbox WHERE id = ? RETURNING kind, question_id"
      ).get(id) as { kind: string; question_id: string } | undefined;
      if (r?.kind === "create") this.deletedCreates.add(id);
      if (r !== undefined) this.closingWritten(r);
    });
  }

  outboxFor(questionId: string): Promise<OutboxItem[]> {
    return this.enqueue("read", () =>
      (
        this.st("SELECT * FROM decisions_outbox WHERE question_id = ? ORDER BY created_at ASC").all(
          questionId
        ) as OutboxRecord[]
      ).map(outboxFrom)
    );
  }

  /**
   * Every withdrawal and decline of the person's queued for the relay
   * (#18052), retrying or not: the question's id, which, and for a decline
   * the round it was signed for. Never anything else of a payload.
   */
  pendingClosings(): Promise<QueuedClosing[]> {
    return this.enqueue("read", () => {
      const rows = this.st(
        `SELECT question_id, kind,
           CASE WHEN kind = 'owner-decline'
             THEN json_extract(payload, '$.signed.record.expected_revision') END AS revision
         FROM decisions_outbox WHERE kind IN ('cancel', 'owner-decline')`
      ).all() as { question_id: string; kind: string; revision: unknown }[];
      return rows.map(({ question_id: questionId, kind, revision }) => ({
        questionId,
        closing: kind === "cancel" ? ("withdrawing" as const) : ("declining" as const),
        revision: kind !== "cancel" && Number.isSafeInteger(revision) ? Number(revision) : null,
      }));
    });
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
      const event = this.st(
        "SELECT event_type, json FROM decisions_inbound_events WHERE seq = ?"
      ).get(seq) as { event_type: string; json: string } | undefined;
      if (event?.event_type !== "decision.deleted") return null;
      const questionId = deletedQuestionOf(event.json);
      return questionId !== null && this.isWithdrawn(questionId) ? questionId : null;
    }).then((deleted) => {
      // Resolved only once the transaction holding it has committed.
      if (deleted !== null) this.notifyDeleted(deleted);
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

  /**
   * Throws `StoreFormatError` when a newer Decisions client wrote this store
   * (0.9.0), so nothing here acts on records it may misread. It only reads:
   * the bridge stamps an older or unmarked store with its own format as it
   * starts (`admitStoreFormat`), and the app database has no other writer.
   */
  checkFormat(): void {
    const row = this.st("SELECT value FROM decisions_meta WHERE key = ?").get(STORE_FORMAT_KEY) as
      { value: unknown } | undefined;
    checkStoreFormat(row?.value);
  }

  processedEventsOfType(eventType: string): Promise<InboundEvent[]> {
    return this.enqueue("read", () =>
      (
        this.st(
          `SELECT * FROM decisions_inbound_events
           WHERE event_type = ? AND processed_at IS NOT NULL ORDER BY seq ASC`
        ).all(eventType) as InboundEvent[]
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
    return this.enqueue("write", () => {
      this.writeIntent(intent);
      if (intent.message_id === null) {
        this.trail(() => {
          const attempt = noticeAttemptOf(this.readQuestion(intent.question_id), intent, nowIso());
          return attempt === null ? [] : [attempt];
        });
      }
    });
  }

  updateIntent(id: string, patch: Partial<InjectionIntent>): Promise<InjectionIntent | null> {
    const copy = { ...patch };
    return this.enqueue("write", () => {
      const current = this.readIntent(id);
      if (!current) return null;
      const next = { ...current, ...copy };
      this.writeIntent(next);
      // Closed straight from being written: nothing reached the terminal. One
      // released from `uncertain` after a reopen may have, and stays so.
      if (next.state === "abandoned" && current.state === "intent" && next.message_id === null) {
        this.trail(() => {
          const untyped = noticeUntypedOf(this.readQuestion(next.question_id), next, nowIso());
          return untyped === null ? [] : [untyped];
        });
      }
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

  uncertainIntents(questionId: string): Promise<InjectionIntent[]> {
    return this.enqueue("read", () =>
      (
        this.st(
          `SELECT * FROM decisions_injection_intents
           WHERE question_id = ? AND message_id IS NULL AND state = 'uncertain'
           ORDER BY created_at ASC, injection_id ASC`
        ).all(questionId) as InjectionIntent[]
      ).map(intentFrom)
    );
  }

  hasUncertainIntent(questionId: string): Promise<boolean> {
    return this.enqueue("read", () => {
      const r = this.st(
        `SELECT 1 FROM decisions_injection_intents
         WHERE question_id = ? AND message_id IS NULL AND state = 'uncertain' LIMIT 1`
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
        const settled = current ? { ...current, ...intentCopy } : null;
        if (settled) this.writeIntent(settled);
        this.patchQuestion(questionId, questionCopy, settled ?? undefined);
      };
    });
  }

  appendAudit(e: AuditEntry): Promise<void> {
    return this.enqueueWith("write", () => {
      const json = JSON.stringify(e);
      const at = e.at;
      return () => {
        this.st("INSERT INTO decisions_audit (at, json) VALUES (?, ?)").run(at, json);
      };
    });
  }

  /**
   * Audit entries written inside the write they describe (#17944). A
   * diagnostic never fails that write: anything but a storage fault, which
   * fails the write anyway, leaves it without its trail.
   */
  private trail(read: () => AuditEntry[]): void {
    try {
      for (const e of read()) {
        this.st("INSERT INTO decisions_audit (at, json) VALUES (?, ?)").run(
          e.at,
          JSON.stringify(e)
        );
      }
    } catch (error) {
      if (isStorageFault(error)) throw error;
    }
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
  private enqueue<T>(kind: OpKind, run: () => T, refusable = false): Promise<T> {
    if (this.closed) return Promise.reject(new DecisionsStoreUnavailableError("closed"));
    if (kind === "read" && this.queue.length === 0) {
      const since = performance.now();
      try {
        return Promise.resolve(run());
      } catch (error) {
        if (!isStorageFault(error)) return Promise.reject(error);
        const site: FaultSite = {
          step: "call",
          writes: false,
          calls: 1,
          elapsedMs: elapsedSince(since),
        };
        return Promise.reject(this.latch(error, site));
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        kind,
        refusable,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
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
      const { outcomes, change } = this.runBatch(ops);
      ops.forEach((op, i) => {
        const outcome = outcomes[i];
        if (outcome.ok) op.resolve(outcome.value);
        else op.reject(outcome.error);
      });
      if (ops.some((op, i) => op.kind === "write" && outcomes[i].ok)) this.notifyCommitted(change);
    } while (drainAll);
    if (this.queue.length > 0) this.scheduled = setImmediate(() => this.flush(false));
  }

  /** The inbox applies a deletion by withdrawing the row: cancelled, and not a history row. */
  private isWithdrawn(questionId: string): boolean {
    const row = this.st(
      "SELECT local_status, history_only FROM decisions_questions WHERE question_id = ?"
    ).get(questionId) as { local_status: string; history_only: number } | undefined;
    return row !== undefined && row.local_status === "cancelled" && Number(row.history_only) === 0;
  }

  private notifyDeleted(questionId: string): void {
    for (const listener of [...this.deletionListeners]) {
      try {
        listener(questionId);
      } catch (error) {
        console.warn("[Decisions] A store deletion listener threw:", error);
      }
    }
  }

  private notifyCommitted(commit: StoreCommit): void {
    for (const listener of [...this.commitListeners]) {
      try {
        listener(commit);
      } catch (error) {
        console.warn("[Decisions] A store commit listener threw:", error);
      }
    }
  }

  private runBatch(ops: Op[]): { outcomes: Outcome[]; change: CommitChange } {
    const outcomes = new Array<Outcome>(ops.length);
    if (!this.fault && getWritesSuppressed()) {
      // A write that can be refused alone is, so a person's removal never stops the store writing.
      ops.forEach((op, i) => {
        if (op.kind === "write" && op.refusable) {
          outcomes[i] = { ok: false, error: new DecisionsStoreUnavailableError("disk-pressure") };
        }
      });
      if (ops.some((op, i) => op.kind === "write" && outcomes[i] === undefined)) {
        this.latch(new DecisionsStoreUnavailableError("disk-pressure"));
      }
    }
    let change = emptyChange();
    const runnable: number[] = [];
    ops.forEach((op, i) => {
      if (outcomes[i] !== undefined) return;
      if (op.kind === "write" && this.fault) outcomes[i] = { ok: false, error: this.fault };
      else runnable.push(i);
    });
    if (runnable.length === 0) return { outcomes, change };

    const writes = runnable.some((i) => ops[i].kind === "write");
    const batch = runnable.map((i) => ops[i]);
    const progress: BatchProgress = { step: "setup", since: performance.now() };
    const siteOf = (step: FaultSite["step"], elapsedMs: number): FaultSite => ({
      step,
      writes,
      calls: batch.length,
      elapsedMs,
    });
    try {
      const committed = this.withCommitLevel(writes, () =>
        withDiskRecovery(this.sqlite, () => this.runTransaction(batch, writes, progress))
      );
      runnable.forEach((opIndex, j) => {
        outcomes[opIndex] = committed.results[j];
      });
      change = committed.change;
      if (committed.fault) {
        this.latch(committed.fault.error, siteOf("call", committed.fault.elapsedMs));
      }
    } catch (error) {
      // The batch rolled back whole, so nothing in it was stored; only the
      // database itself (begin, commit, an I/O error) fails a whole batch.
      const refused = this.latch(error, siteOf(progress.step, elapsedSince(progress.since)));
      for (const i of runnable) outcomes[i] = { ok: false, error: refused };
    }
    return { outcomes, change };
  }

  /**
   * A batch with writes in it takes the write lock as it begins (`BEGIN
   * IMMEDIATE`), so another connection holding it is waited out for the
   * connection's busy timeout. Begun deferred, a call that reads before it
   * writes would hold a read snapshot by then, and SQLite refuses that upgrade
   * at once with `SQLITE_BUSY` rather than wait (#16840).
   */
  private runTransaction(
    ops: Op[],
    writes: boolean,
    progress: BatchProgress
  ): {
    results: Outcome[];
    fault: { error: unknown; elapsedMs: number } | null;
    change: CommitChange;
  } {
    const batch = this.sqlite.transaction(() => {
      let fault: { error: unknown; elapsedMs: number } | null = null;
      // A retried transaction starts its record over.
      const change = emptyChange();
      const results = ops.map((op): Outcome => {
        // A write after a storage error in the same batch must not commit
        // without the one that failed.
        if (op.kind === "write" && fault !== null) {
          return { ok: false, error: this.storageFault(fault.error) };
        }
        progress.step = "call";
        progress.since = performance.now();
        const wrote = emptyChange();
        this.writing = wrote;
        try {
          const value = this.sqlite.transaction(op.run)();
          // Only a call whose savepoint was released counts.
          for (const id of wrote.questions) change.questions.add(id);
          for (const key of wrote.meta) change.meta.add(key);
          return { ok: true, value };
        } catch (error) {
          // SQLite ends the whole transaction itself on some I/O errors;
          // carrying on would run the rest outside any transaction.
          if (!this.sqlite.inTransaction) throw error;
          if (!isStorageFault(error)) return { ok: false, error };
          // Timed now: the calls after it and the commit aren't its wait.
          fault = { error, elapsedMs: elapsedSince(progress.since) };
          return { ok: false, error: this.storageFault(error) };
        } finally {
          this.writing = null;
        }
      });
      progress.step = "commit";
      progress.since = performance.now();
      return { results, fault, change };
    });
    progress.step = "begin";
    progress.since = performance.now();
    return writes ? batch.immediate() : batch();
  }

  private withCommitLevel<T>(writes: boolean, fn: () => T): T {
    return writes ? withFullSync(this.sqlite, fn) : fn();
  }

  /**
   * Stops this store writing. A failed read counts too: the library treats a
   * question it couldn't read as an event it couldn't apply, and would mark
   * that event processed with its next write.
   */
  private latch(cause: unknown, site?: FaultSite): DecisionsStoreUnavailableError {
    const fault = this.storageFault(cause);
    if (this.fault !== null) return fault;
    this.fault = fault;
    // Under disk pressure the logger drops this line too; the restart after it logs again.
    const code = (fault.cause as { code?: unknown } | null | undefined)?.code;
    logWarn("[Decisions] The local store stopped taking writes", {
      reason: fault.reason,
      ...(typeof code === "string" ? { code } : {}),
      ...site,
    });
    for (const listener of [...this.faultListeners]) {
      try {
        listener(fault.reason);
      } catch (error) {
        console.warn("[Decisions] A store fault listener threw:", error);
      }
    }
    return fault;
  }

  private storageFault(cause: unknown): DecisionsStoreUnavailableError {
    if (cause instanceof DecisionsStoreUnavailableError) return cause;
    const code = (cause as { code?: unknown } | null)?.code;
    return new DecisionsStoreUnavailableError(
      code === "SQLITE_FULL" ? "disk-full" : isBusyCode(code) ? "storage-busy" : "storage-fault",
      { cause }
    );
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
      { value: string } | undefined;
    return r ? r.value : null;
  }

  private writeMeta(key: string, value: string): void {
    this.st(
      `INSERT INTO decisions_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
    this.writing?.meta.add(key);
  }

  private readCursor(): number {
    return Number(this.readMeta("cursor") ?? "0");
  }

  private readQuestion(id: string): QuestionRow | null {
    const r = this.st("SELECT * FROM decisions_questions WHERE question_id = ?").get(id) as
      QuestionRecord | undefined;
    return r ? fromRecord(r) : null;
  }

  private patchQuestion(
    id: string,
    patch: Partial<QuestionRow>,
    settled?: SettledIntent
  ): QuestionRow | null {
    const current = this.readQuestion(id);
    if (!current) return null;
    const next: QuestionRow = {
      ...current,
      ...keepingCancelled(current, keepingLaterEvent(current, patch)),
      question_id: current.question_id,
      origin: { ...current.origin, ...(patch.origin ?? {}) },
    };
    this.st(UPDATE_QUESTION).run(toRecord(next));
    this.writing?.questions.add(current.question_id);
    // The notice's trail goes in the same write as the change it records.
    if (TRAIL_FIELDS.some((field) => field in patch)) {
      this.trail(() => noticeTrailOf(current, next, nowIso(), settled));
    }
    return next;
  }

  private refuseDeletedCreate(record: OutboxRecord): void {
    if (!this.deletedCreates.has(record.id)) return;
    const stored = this.st("SELECT 1 FROM decisions_outbox WHERE id = ?").get(record.id);
    if (stored === undefined) {
      throw new Error("This question's create is no longer queued, so it isn't written back");
    }
  }

  /**
   * A queued withdrawal or decline is read beside the rows (#18052): its
   * queuing or sending names its question, so a reader following commits
   * reads what the question's pane shows again.
   */
  private closingWritten(record: { kind: string; question_id: string }): void {
    if (CLOSING_KINDS.has(record.kind)) this.writing?.questions.add(record.question_id);
  }

  private writeOutbox(record: OutboxRecord): void {
    this.closingWritten(record);
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
         (injection_id, question_id, answer_revision, message_id, host_id, pane_id,
          terminal_generation, ownership_principal, agent_incarnation, state, created_at,
          updated_at)
       VALUES (@injection_id, @question_id, @answer_revision, @message_id, @host_id, @pane_id,
         @terminal_generation, @ownership_principal, @agent_incarnation, @state, @created_at,
         @updated_at)`
    ).run(intentFrom(i));
  }
}

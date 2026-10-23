import {
  PLUGIN_TASK_MAX_LIVE,
  PLUGIN_TASK_MESSAGE_MAX,
  PLUGIN_TASK_TITLE_MAX,
  type PluginDatabase,
  type PluginDatabaseApi,
  type PluginDatabaseStatements,
  type PluginTaskApi,
  type PluginTaskHandle,
  type PluginTaskResult,
} from "../../../../shared/types/plugin.js";
import type { ActionId } from "../../../../shared/types/actions.js";

/**
 * The slice of the host the manager needs. `PluginHostApi` satisfies it.
 */
export interface OperationManagerHost {
  readonly db: Pick<PluginDatabaseApi, "open">;
  readonly tasks: PluginTaskApi;
}

/** Plain JSON, the only thing the journal stores. */
export type OperationJson =
  null | boolean | number | string | OperationJson[] | { [key: string]: OperationJson };

/**
 * Where an operation stands.
 *
 * - `pending`: journaled, not yet sent to the provider (or proven never received).
 * - `submitting`: the submit call is in flight. Found at start-up, it means the
 *   plugin stopped mid-call, and becomes `uncertain`.
 * - `uncertain`: the submit may or may not have reached the provider; it is
 *   reconciled before anything is sent again.
 * - `running`: the provider has it, under `providerId`; it is polled.
 * - `succeeded`, `failed`, `cancelled`: what the provider reported (a
 *   `cancelled` is only ever the provider's, or one never sent).
 * - `abandoned`: the manager stopped tracking it — deadline, retries spent, or
 *   {@link OperationManager.abandon} — and the provider's outcome is unknown.
 */
export type OperationState =
  | "pending"
  | "submitting"
  | "uncertain"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "abandoned";

export const OPERATION_TERMINAL_STATES: readonly OperationState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
];

/** Serialized size caps, in UTF-16 code units of the JSON. */
export const OPERATION_INPUT_MAX_CHARS = 32 * 1024;
export const OPERATION_CHECKPOINT_MAX_CHARS = 16 * 1024;
export const OPERATION_RESULT_MAX_CHARS = 64 * 1024;
export const OPERATION_IDEMPOTENCY_KEY_MAX = 256;
export const OPERATION_ERROR_MESSAGE_MAX = 500;
export const OPERATION_LIST_MAX = 100;

/**
 * An error a provider adapter throws on purpose. Its `code` and `message` are
 * stored in the journal and shown to the user, so they must say what happened
 * without carrying credentials or customer data. Any other error is stored as
 * a generic `PROVIDER_ERROR`, never by its message.
 *
 * `retryable: false` is final: from `submit`, it says the provider refused the
 * request and nothing happened; from `poll`, that the operation failed.
 */
export class OperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.retryable = options.retryable ?? true;
  }
}

/** The same idempotency key was submitted with a different request. */
export class OperationConflictError extends Error {
  readonly operationId: string;
  constructor(operationId: string) {
    super(`idempotency key already used by operation ${operationId} with a different request`);
    this.name = "OperationConflictError";
    this.operationId = operationId;
  }
}

/** The journal already holds the maximum number of unfinished operations. */
export class OperationCapacityError extends Error {
  constructor(limit: number) {
    super(`already tracking ${limit} unfinished operations`);
    this.name = "OperationCapacityError";
  }
}

/** Handed to every provider call. */
export interface OperationCallContext {
  operationId: string;
  /** Stable across every attempt and every restart. Send it to the provider. */
  idempotencyKey: string;
  /** Aborts when the call times out or the manager stops. */
  signal: AbortSignal;
}

/** What the provider knows the operation by, and the adapter's last checkpoint. */
export interface OperationRef {
  providerId: string;
  checkpoint: OperationJson | null;
}

export interface OperationProgress {
  fraction?: number | null;
  detail?: string;
}

export type OperationPollResult<Result> =
  | {
      status: "running";
      checkpoint?: OperationJson;
      progress?: OperationProgress;
      /** Overrides the kind's `pollIntervalMs` for the next poll. */
      nextPollMs?: number;
    }
  | { status: "succeeded"; result?: Result }
  | { status: "failed"; message: string; code?: string }
  | { status: "cancelled" };

/**
 * What reconciliation found for a submit that may have reached the provider:
 * the operation, proof there is none (so sending it again is safe), or no
 * answer yet.
 */
export type OperationReconcileResult =
  | { status: "found"; providerId: string; checkpoint?: OperationJson }
  | { status: "not-found" }
  | { status: "unknown" };

/**
 * The provider side of one kind of operation. Credentials are the adapter's
 * to fetch at call time; nothing it is handed or returns should carry them.
 */
export interface OperationProvider<Input, Result> {
  /** Start the work remotely. Must honour `ctx.idempotencyKey` unless `reconcile` is given. */
  submit(
    input: Input,
    ctx: OperationCallContext
  ): Promise<{ providerId: string; checkpoint?: OperationJson }>;
  poll(ref: OperationRef, ctx: OperationCallContext): Promise<OperationPollResult<Result>>;
  /**
   * Look the operation up by `ctx.idempotencyKey` after a submit whose outcome
   * is unknown. Without it, an uncertain submit is sent again with the same
   * key, so the provider must deduplicate on it.
   */
  reconcile?(input: Input, ctx: OperationCallContext): Promise<OperationReconcileResult>;
  /**
   * Ask the provider to cancel. `"cancelled"` confirms it; `"requested"` means
   * it was asked and polling will tell; `"unsupported"` means it can't be.
   */
  cancel?(
    ref: OperationRef,
    ctx: OperationCallContext
  ): Promise<"cancelled" | "requested" | "unsupported">;
}

/**
 * Backoff for failed provider calls, Temporal's subset: the n-th consecutive
 * failure waits a uniformly random time up to
 * `min(maximumIntervalMs, initialIntervalMs * backoffCoefficient ** (n - 1))`.
 * After `maximumAttempts` consecutive failures the operation is abandoned.
 * A poll that answers "still running" is not a failure.
 */
export interface OperationRetryPolicy {
  initialIntervalMs: number;
  backoffCoefficient: number;
  maximumIntervalMs: number;
  maximumAttempts: number;
}

export interface OperationKind<Input, Result> {
  provider: OperationProvider<Input, Result>;
  /** The task title, from the input. Truncated to the host's task-title cap. */
  title: (input: Input) => string;
  /** How long after submission the manager keeps trying. Default 24 hours. */
  deadlineMs?: number;
  /** Default 5 s. */
  pollIntervalMs?: number;
  /** One provider call's budget. A timed-out call is a failure, never a cancel. Default 30 s. */
  callTimeoutMs?: number;
  retry?: Partial<OperationRetryPolicy>;
}

export interface OperationManagerOptions {
  /**
   * A `contributes.databases` id the manager owns: it applies its own
   * migrations, so the file holds nothing else. Declare it
   * `"location": "local"` so the journal stays out of the repository.
   */
  database: string;
  /**
   * The plugin's own action that resumes an operation, written
   * `"{manifest name}.{id}"`. It receives `{ operationId }` and should call
   * {@link OperationManager.retry}. Offered as Retry on a failed or
   * interrupted task.
   */
  retryActionId: ActionId;
  // Heterogeneous kinds: each entry's input and result types are its own.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kinds: Record<string, OperationKind<any, any>>;
  /** Operations driven at once, each holding one host task. Default 4, at most 16. */
  concurrency?: number;
  /** Unfinished operations the journal admits. Default 200. */
  maxUnfinished?: number;
  /** Finished operations kept: newer than `maxAgeMs` (default 7 days), at most `maxCount` (default 500). */
  retention?: { maxAgeMs?: number; maxCount?: number };
  /** Injected for tests. */
  now?: () => number;
  random?: () => number;
}

export interface OperationSubmitOptions {
  /**
   * Deduplicates submissions: the same key and request returns the existing
   * operation, however it ended, until it is pruned. Defaults to a fresh id.
   */
  idempotencyKey?: string;
  /** The project the request came from, for {@link OperationManager.list}. */
  projectId?: string | null;
}

export interface OperationSnapshot<Result = unknown> {
  id: string;
  kind: string;
  idempotencyKey: string;
  projectId: string | null;
  title: string;
  state: OperationState;
  providerId: string | null;
  progress: { fraction: number | null; detail?: string } | null;
  /** Set once `succeeded`, when the provider returned one. */
  result?: Result;
  error: { code: string; message: string } | null;
  /** Consecutive failed provider calls. */
  attempt: number;
  /** A cancel was asked for. Only `state` says whether the provider confirmed it. */
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  deadlineAt: number;
}

export interface OperationListFilter {
  /** `null` lists operations with no project; omit for every project. */
  projectId?: string | null;
  states?: readonly OperationState[];
  /** Newest first. Default and maximum 100. */
  limit?: number;
}

export interface OperationManager {
  /**
   * Open the journal, mark submits a previous run left in flight uncertain,
   * prune, and resume unfinished operations in the background. Call it from
   * `activate`; it returns without waiting for any provider. Repeat calls
   * share the first successful open, and resume driving after an interruption.
   */
  start(): Promise<void>;
  /** Journal an operation and return once it is committed, before the provider hears of it. */
  submit<Result = unknown>(
    kind: string,
    input: unknown,
    options?: OperationSubmitOptions
  ): Promise<OperationSnapshot<Result>>;
  get<Result = unknown>(id: string): Promise<OperationSnapshot<Result> | undefined>;
  list(filter?: OperationListFilter): Promise<OperationSnapshot[]>;
  /**
   * Ask for an operation to be cancelled. One never sent ends `cancelled` at
   * once; otherwise the request is recorded and the provider asked, and the
   * operation is `cancelled` only when the provider says so.
   */
  cancel(id: string): Promise<OperationSnapshot | undefined>;
  /**
   * Resume an operation: an unfinished one is driven again if it isn't, and an
   * abandoned one gets a fresh deadline and retry budget and is reconciled
   * with the provider under the same key. Finished ones are returned as they are.
   */
  retry(id: string): Promise<OperationSnapshot | undefined>;
  /** Stop tracking an unfinished operation. Its provider outcome stays unknown. */
  abandon(id: string): Promise<OperationSnapshot | undefined>;
  /** Apply the retention policy now. Returns how many finished operations were removed. */
  prune(): Promise<number>;
  /** Stop driving and close the journal. Unfinished operations resume on the next `start`. */
  dispose(): Promise<void>;
}

interface OperationRow {
  id: string;
  kind: string;
  idempotency_key: string;
  request_hash: string;
  project_id: string | null;
  title: string;
  input: string;
  state: OperationState;
  /** Bumped by `abandon` and `retry`, so a provider answer from before either is dropped. */
  generation: number;
  provider_id: string | null;
  checkpoint: string | null;
  progress: string | null;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt: number;
  next_attempt_at: number;
  deadline_at: number;
  /** When a submit was first sent: from then on the provider may have it. */
  submitted_at: number | null;
  cancel_requested_at: number | null;
  cancel_sent_at: number | null;
  created_at: number;
  updated_at: number;
}

type RowPatch = Partial<
  Omit<OperationRow, "id" | "kind" | "idempotency_key" | "request_hash" | "generation">
>;

const MIGRATIONS = [
  `CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    input TEXT NOT NULL,
    state TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    provider_id TEXT,
    checkpoint TEXT,
    progress TEXT,
    result TEXT,
    error_code TEXT,
    error_message TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    submitted_at INTEGER,
    cancel_requested_at INTEGER,
    cancel_sent_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX operations_by_state ON operations (state, next_attempt_at);
  CREATE INDEX operations_by_project ON operations (project_id, created_at);`,
];

const TERMINAL = new Set<OperationState>(OPERATION_TERMINAL_STATES);
const TERMINAL_SQL = OPERATION_TERMINAL_STATES.map((s) => `'${s}'`).join(", ");
const POLL_STATUSES = new Set(["running", "succeeded", "failed", "cancelled"]);

const DEFAULT_RETRY: OperationRetryPolicy = {
  initialIntervalMs: 1_000,
  backoffCoefficient: 2,
  maximumIntervalMs: 60_000,
  maximumAttempts: 10,
};
const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const TASK_START_RETRY_MS = 5_000;

class StoppedError extends Error {}
class CallTimeoutError extends Error {}

const invalidResponse = (what: string) =>
  new OperationError("INVALID_RESPONSE", `The provider adapter returned an invalid ${what}`);

interface Drive {
  readonly stop: AbortController;
  task: PluginTaskHandle | null;
  /** The task was finished, by this manager, exactly once. */
  released: boolean;
  /** The drive threw: the next admission waits for the retry timer. */
  failed: boolean;
  wake: () => void;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One line of text, as the host's task fields require, never empty. */
function oneLine(text: string, max: number, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return truncate(line.length > 0 ? line : fallback, max);
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** JSON with object keys sorted, so equal requests hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, (v as Record<string, unknown>)[k]])
    );
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeJson(value: unknown, max: number, what: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new TypeError(`${what} must be JSON-serializable`);
  }
  if (text === undefined) throw new TypeError(`${what} must be JSON-serializable`);
  if (text.length > max) throw new RangeError(`${what} exceeds ${max} characters of JSON`);
  return text;
}

/** A checkpoint as stored, or `undefined` when it is too large or not JSON. */
function encodeCheckpoint(value: OperationJson): string | undefined {
  try {
    return encodeJson(value, OPERATION_CHECKPOINT_MAX_CHARS, "checkpoint");
  } catch {
    return undefined;
  }
}

function parseJson<T>(text: string | null): T | undefined {
  return text === null ? undefined : (JSON.parse(text) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

/** What the journal keeps of a failed call: never a raw message, which may carry secrets. */
function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof OperationError) {
    return {
      code: oneLine(String(error.code), 64, "OPERATION_ERROR"),
      message: oneLine(String(error.message), OPERATION_ERROR_MESSAGE_MAX, "The operation failed"),
    };
  }
  if (error instanceof CallTimeoutError) {
    return { code: "TIMEOUT", message: "The provider call timed out" };
  }
  return { code: "PROVIDER_ERROR", message: "The provider call failed" };
}

function toSnapshot(row: OperationRow): OperationSnapshot {
  const snapshot: OperationSnapshot = {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    title: row.title,
    state: row.state,
    providerId: row.provider_id,
    progress: parseJson(row.progress) ?? null,
    error:
      row.error_code === null ? null : { code: row.error_code, message: row.error_message ?? "" },
    attempt: row.attempt,
    cancelRequested: row.cancel_requested_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    deadlineAt: row.deadline_at,
  };
  if (row.result !== null) snapshot.result = parseJson(row.result);
  return snapshot;
}

/**
 * Durable, recoverable operations over `host.db` and `host.tasks` (#14109).
 * Each operation is one remote job — submitted once, polled to an end — whose
 * identity and state are committed before anything is acknowledged or sent,
 * so a worker reload, project reopen or app restart picks it up where it was.
 * Work runs only while the plugin does; nothing executes after it stops.
 *
 * Every operation being driven holds a host task, which is what the user sees
 * and what keeps a project-scoped plugin's project awake. The task's Cancel
 * records a cancel request; an interruption (the plugin unloading) records
 * nothing and suspends driving until the next `start`, `submit` or `retry`.
 */
export function createOperationManager(
  host: OperationManagerHost,
  options: OperationManagerOptions
): OperationManager {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const concurrency = Math.min(
    PLUGIN_TASK_MAX_LIVE,
    Math.max(1, Math.floor(positiveNumber(options.concurrency, 4)))
  );
  const maxUnfinished = Math.floor(positiveNumber(options.maxUnfinished, 200));
  const retentionAgeMs = positiveNumber(options.retention?.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
  const retentionCount = Math.floor(positiveNumber(options.retention?.maxCount, 500));

  let db: PluginDatabase | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  // Set when the host interrupts a task: the plugin is stopping, so nothing
  // more is admitted until something asks for work again.
  let suspended = false;
  const driving = new Map<string, Drive>();
  const runs = new Set<Promise<void>>();
  // A flag rather than the run's promise: a pass that ends before its first
  // await settles before the assignment, and would read as running forever.
  let pumping = false;
  let pumpRun: Promise<void> = Promise.resolve();
  let pumpAgain = false;
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;

  const kindOf = (kind: string): OperationKind<unknown, unknown> => {
    const def = Object.prototype.hasOwnProperty.call(options.kinds, kind)
      ? options.kinds[kind]
      : undefined;
    if (!def) throw new TypeError(`unknown operation kind "${kind}"`);
    return def;
  };
  const retryPolicy = (kind: string): OperationRetryPolicy => {
    const p = { ...DEFAULT_RETRY, ...kindOf(kind).retry };
    return {
      initialIntervalMs: positiveNumber(p.initialIntervalMs, DEFAULT_RETRY.initialIntervalMs),
      backoffCoefficient: positiveNumber(p.backoffCoefficient, DEFAULT_RETRY.backoffCoefficient),
      maximumIntervalMs: positiveNumber(p.maximumIntervalMs, DEFAULT_RETRY.maximumIntervalMs),
      maximumAttempts: Math.floor(positiveNumber(p.maximumAttempts, DEFAULT_RETRY.maximumAttempts)),
    };
  };
  const backoff = (kind: string, failures: number): number => {
    const p = retryPolicy(kind);
    const cap = Math.min(
      p.maximumIntervalMs,
      p.initialIntervalMs * p.backoffCoefficient ** Math.max(0, failures - 1)
    );
    return Math.floor(random() * cap);
  };
  const pollInterval = (kind: string) =>
    positiveNumber(kindOf(kind).pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const deadlineFor = (kind: string) =>
    positiveNumber(kindOf(kind).deadlineMs, DEFAULT_DEADLINE_MS);

  // Not gated on `disposed`: a call that lands while dispose waits for the
  // drives still records what the provider said.
  const requireDb = (): PluginDatabase => {
    if (!db) throw new Error("operation manager is not running");
    return db;
  };

  const load = async (id: string, from: PluginDatabaseStatements = requireDb()) =>
    from.get<OperationRow>("SELECT * FROM operations WHERE id = ?", [id]);

  /**
   * Apply `patch` if the row is still as `row` read it — same state, same
   * generation. A row someone else moved on (a cancel of an unsent submit, an
   * abandon, a retry) is left alone, and the drive re-reads it.
   */
  const transition = async (row: OperationRow, patch: RowPatch): Promise<boolean> => {
    const entries = Object.entries({ ...patch, updated_at: now() });
    const sets = entries.map(([column]) => `${column} = ?`).join(", ");
    const result = await requireDb().run(
      `UPDATE operations SET ${sets} WHERE id = ? AND state = ? AND generation = ?`,
      [
        ...entries.map(([, value]) => value as string | number | null),
        row.id,
        row.state,
        row.generation,
      ]
    );
    return result.changes > 0;
  };

  const failurePatch = (row: OperationRow, error: unknown, next: OperationState): RowPatch => {
    const failures = row.attempt + 1;
    const failure = describeFailure(error);
    if (failures >= retryPolicy(row.kind).maximumAttempts) {
      return {
        state: "abandoned",
        attempt: failures,
        error_code: failure.code,
        error_message: truncate(
          `Stopped after ${failures} failed attempts; the provider's outcome is unknown. Last: ${failure.message}`,
          OPERATION_ERROR_MESSAGE_MAX
        ),
      };
    }
    return {
      state: next,
      attempt: failures,
      next_attempt_at: now() + backoff(row.kind, failures),
      error_code: failure.code,
      error_message: failure.message,
    };
  };

  const checkpointRejected = (providerId: string): RowPatch => ({
    state: "abandoned",
    provider_id: providerId,
    error_code: "CHECKPOINT_REJECTED",
    error_message:
      "The adapter's checkpoint was too large or not JSON; the provider's outcome is unknown",
  });

  /**
   * One provider call, bounded by the kind's timeout, the operation's deadline
   * and the drive's stop. The manager's own reason settles the race before the
   * provider's signal aborts, so a provider rejecting on abort can't pass an
   * interruption off as a failed call.
   */
  const call = async <T>(
    row: OperationRow,
    drive: Drive,
    fn: (ctx: OperationCallContext) => Promise<T>
  ): Promise<T> => {
    if (drive.stop.signal.aborted) throw new StoppedError();
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      Math.min(
        positiveNumber(kindOf(row.kind).callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS),
        row.deadline_at - now()
      )
    );
    let onStop: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CallTimeoutError());
        controller.abort();
      }, timeoutMs);
      onStop = () => {
        reject(new StoppedError());
        controller.abort();
      };
      drive.stop.signal.addEventListener("abort", onStop, { once: true });
    });
    ended.catch(() => {});
    try {
      const answer = Promise.resolve().then(() =>
        fn({ operationId: row.id, idempotencyKey: row.idempotency_key, signal: controller.signal })
      );
      answer.catch(() => {});
      return await Promise.race([ended, answer]);
    } finally {
      clearTimeout(timer);
      drive.stop.signal.removeEventListener("abort", onStop);
    }
  };

  const ref = (row: OperationRow): OperationRef => ({
    providerId: row.provider_id ?? "",
    checkpoint: parseJson<OperationJson>(row.checkpoint) ?? null,
  });

  const waitFor = (ms: number, drive: Drive): Promise<void> =>
    new Promise((resolve) => {
      if (ms <= 0 || drive.stop.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        drive.stop.signal.removeEventListener("abort", done);
        drive.wake = () => {};
        resolve();
      };
      const timer = setTimeout(done, ms);
      drive.wake = done;
      drive.stop.signal.addEventListener("abort", done, { once: true });
    });

  /** One step for a row that is due. Makes at most one provider call. */
  const step = async (row: OperationRow, drive: Drive): Promise<void> => {
    const kind = kindOf(row.kind);
    const provider = kind.provider;
    const input = (): unknown => JSON.parse(row.input);
    const cancelRequested = row.cancel_requested_at !== null;

    switch (row.state) {
      case "pending": {
        if (cancelRequested) {
          // Sent before, with no way to look it up: it may exist remotely.
          await transition(
            row,
            row.submitted_at === null
              ? { state: "cancelled" }
              : {
                  state: "abandoned",
                  error_code: "CANCEL_UNCONFIRMED",
                  error_message:
                    "Cancelled before the provider confirmed the submit; whether it received it is unknown",
                }
          );
          return;
        }
        const sending: RowPatch = { state: "submitting", submitted_at: row.submitted_at ?? now() };
        if (!(await transition(row, sending))) return;
        const submitting: OperationRow = { ...row, ...sending } as OperationRow;
        let accepted: unknown;
        try {
          accepted = await call(row, drive, (ctx) => provider.submit(input(), ctx));
        } catch (error) {
          // Stopped mid-call: left `submitting`, which the next start makes uncertain.
          if (error instanceof StoppedError) return;
          if (error instanceof OperationError && !error.retryable) {
            const failure = describeFailure(error);
            await transition(submitting, {
              state: "failed",
              error_code: failure.code,
              error_message: failure.message,
            });
            return;
          }
          await transition(submitting, failurePatch(submitting, error, "uncertain"));
          return;
        }
        if (!isRecord(accepted) || !validProviderId(accepted.providerId)) {
          await transition(
            submitting,
            failurePatch(submitting, invalidResponse("submit answer"), "uncertain")
          );
          return;
        }
        const checkpoint =
          accepted.checkpoint === undefined
            ? null
            : encodeCheckpoint(accepted.checkpoint as OperationJson);
        await transition(
          submitting,
          checkpoint === undefined
            ? checkpointRejected(accepted.providerId)
            : {
                state: "running",
                provider_id: accepted.providerId,
                checkpoint,
                attempt: 0,
                error_code: null,
                error_message: null,
                next_attempt_at: now() + pollInterval(row.kind),
              }
        );
        return;
      }
      case "submitting": {
        await transition(row, { state: "uncertain" });
        return;
      }
      case "uncertain": {
        const reconcile = provider.reconcile?.bind(provider);
        if (!reconcile) {
          // The provider deduplicates on the key, so sending it again is safe.
          await transition(row, { state: "pending" });
          return;
        }
        let found: unknown;
        try {
          found = await call(row, drive, (ctx) => reconcile(input(), ctx));
        } catch (error) {
          if (error instanceof StoppedError) return;
          await transition(row, failurePatch(row, error, "uncertain"));
          return;
        }
        const status = isRecord(found) ? found.status : undefined;
        if (status === "found" && isRecord(found) && validProviderId(found.providerId)) {
          const checkpoint =
            found.checkpoint === undefined
              ? row.checkpoint
              : encodeCheckpoint(found.checkpoint as OperationJson);
          await transition(
            row,
            checkpoint === undefined
              ? checkpointRejected(found.providerId)
              : {
                  state: "running",
                  provider_id: found.providerId,
                  checkpoint,
                  attempt: 0,
                  error_code: null,
                  error_message: null,
                  next_attempt_at: now(),
                }
          );
        } else if (status === "not-found") {
          // Proven never received: nothing exists remotely to cancel or duplicate.
          await transition(
            row,
            cancelRequested
              ? { state: "cancelled" }
              : { state: "pending", submitted_at: null, next_attempt_at: now() }
          );
        } else {
          await transition(
            row,
            failurePatch(
              row,
              status === "unknown"
                ? new OperationError(
                    "UNRECONCILED",
                    "The provider could not say whether it received the submit"
                  )
                : invalidResponse("reconcile answer"),
              "uncertain"
            )
          );
        }
        return;
      }
      case "running": {
        const cancel = provider.cancel?.bind(provider);
        if (cancelRequested && row.cancel_sent_at === null) {
          let answer: unknown = "unsupported";
          if (cancel) {
            try {
              answer = await call(row, drive, (ctx) => cancel(ref(row), ctx));
            } catch (error) {
              if (error instanceof StoppedError) return;
              // Delivery unknown: ask again after a backoff.
              await transition(row, failurePatch(row, error, "running"));
              return;
            }
          }
          await transition(
            row,
            answer === "cancelled"
              ? { state: "cancelled", cancel_sent_at: now() }
              : { cancel_sent_at: now(), attempt: 0 }
          );
          return;
        }
        let polled: unknown;
        try {
          polled = await call(row, drive, (ctx) => provider.poll(ref(row), ctx));
        } catch (error) {
          if (error instanceof StoppedError) return;
          if (error instanceof OperationError && !error.retryable) {
            const failure = describeFailure(error);
            await transition(row, {
              state: "failed",
              error_code: failure.code,
              error_message: failure.message,
            });
            return;
          }
          await transition(row, failurePatch(row, error, "running"));
          return;
        }
        if (!isRecord(polled) || !POLL_STATUSES.has(polled.status as string)) {
          await transition(row, failurePatch(row, invalidResponse("poll answer"), "running"));
          return;
        }
        const answer = polled as OperationPollResult<unknown>;
        if (answer.status === "running") {
          const checkpoint =
            answer.checkpoint === undefined ? row.checkpoint : encodeCheckpoint(answer.checkpoint);
          if (checkpoint === undefined) {
            // An adapter bug, not a provider failure: resuming would lose its place.
            await transition(row, checkpointRejected(row.provider_id ?? ""));
            return;
          }
          const progress = isRecord(answer.progress) ? answer.progress : undefined;
          const fraction = progress?.fraction;
          await transition(row, {
            checkpoint,
            progress:
              progress === undefined
                ? row.progress
                : JSON.stringify({
                    fraction:
                      typeof fraction === "number" && Number.isFinite(fraction)
                        ? Math.min(1, Math.max(0, fraction))
                        : null,
                    ...(typeof progress.detail === "string" && progress.detail.trim()
                      ? { detail: oneLine(progress.detail, 200, "") }
                      : {}),
                  }),
            attempt: 0,
            error_code: null,
            error_message: null,
            next_attempt_at:
              now() +
              (typeof answer.nextPollMs === "number" && Number.isFinite(answer.nextPollMs)
                ? Math.max(0, answer.nextPollMs)
                : pollInterval(row.kind)),
          });
        } else if (answer.status === "succeeded") {
          let result: string | null = null;
          let error: { code: string; message: string } | null = null;
          if (answer.result !== undefined) {
            try {
              result = encodeJson(answer.result, OPERATION_RESULT_MAX_CHARS, "result");
            } catch {
              error = {
                code: "RESULT_NOT_STORED",
                message: "The provider's result was too large or not JSON, so it was not kept",
              };
            }
          }
          await transition(row, {
            state: "succeeded",
            result,
            progress: JSON.stringify({ fraction: 1 }),
            error_code: error?.code ?? null,
            error_message: error?.message ?? null,
          });
        } else if (answer.status === "failed") {
          await transition(row, {
            state: "failed",
            error_code: oneLine(String(answer.code ?? "PROVIDER_FAILED"), 64, "PROVIDER_FAILED"),
            error_message: oneLine(
              String(answer.message ?? ""),
              OPERATION_ERROR_MESSAGE_MAX,
              "The provider reported a failure"
            ),
          });
        } else {
          await transition(row, { state: "cancelled" });
        }
        return;
      }
      default:
        return;
    }
  };

  const reportProgress = (task: PluginTaskHandle, row: OperationRow): void => {
    const progress = parseJson<{ fraction: number | null; detail?: string }>(row.progress);
    const detail =
      row.cancel_requested_at !== null
        ? "Cancel requested; waiting for the provider"
        : (progress?.detail ?? "");
    try {
      task.report({ fraction: progress?.fraction ?? null, detail });
    } catch {
      // Progress is presentation; a report the host refuses changes nothing durable.
    }
  };

  const release = async (drive: Drive, result: PluginTaskResult): Promise<void> => {
    if (drive.released || !drive.task) return;
    drive.released = true;
    await drive.task.finish(result).catch(() => {});
  };

  const finishTask = (drive: Drive, row: OperationRow): Promise<void> => {
    if (row.state === "succeeded") return release(drive, { outcome: "succeeded" });
    if (row.state === "cancelled") return release(drive, { outcome: "cancelled" });
    return release(drive, {
      outcome: "failed",
      message: oneLine(
        row.error_message ?? "",
        PLUGIN_TASK_MESSAGE_MAX,
        row.state === "abandoned" ? "Stopped tracking the operation" : "The operation failed"
      ),
    });
  };

  const isInterrupted = (task: PluginTaskHandle): boolean =>
    task.signal.aborted &&
    (task.signal.reason as { cause?: unknown } | undefined)?.cause !== "cancelled";

  const driveOperation = async (id: string, drive: Drive): Promise<void> => {
    let row = await load(id);
    if (!row || TERMINAL.has(row.state) || drive.stop.signal.aborted) return;
    const task = await host.tasks.start({
      title: oneLine(row.title, PLUGIN_TASK_TITLE_MAX, "Operation"),
      cancellable: true,
      retry: { actionId: options.retryActionId, args: { operationId: id } },
    });
    drive.task = task;
    const onAbort = () => {
      if (!isInterrupted(task)) {
        void manager.cancel(id).catch(() => {});
        return;
      }
      // The host is stopping the plugin: leave the journal as it is.
      suspended = true;
      for (const entry of driving.values()) entry.stop.abort();
    };
    if (task.signal.aborted) onAbort();
    else task.signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!drive.stop.signal.aborted) {
        row = await load(id);
        if (!row) return;
        if (TERMINAL.has(row.state)) {
          await finishTask(drive, row);
          void prune().catch(() => {});
          return;
        }
        reportProgress(task, row);
        if (now() >= row.deadline_at) {
          await transition(
            row,
            row.state === "pending" && row.submitted_at === null
              ? {
                  state: "failed",
                  error_code: "DEADLINE_EXCEEDED",
                  error_message: "Not submitted before its deadline",
                }
              : {
                  state: "abandoned",
                  error_code: "DEADLINE_EXCEEDED",
                  error_message:
                    "Stopped tracking at its deadline; the provider's outcome is unknown",
                }
          );
          continue;
        }
        // A fresh cancel request goes to the provider now, not at the next poll.
        const cancelNow =
          row.state === "running" &&
          row.cancel_requested_at !== null &&
          row.cancel_sent_at === null &&
          row.attempt === 0;
        const due = cancelNow ? 0 : row.next_attempt_at - now();
        if (due > 0) {
          await waitFor(Math.min(due, row.deadline_at - now()), drive);
          continue;
        }
        await step(row, drive);
      }
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      // Any other way out — dispose, a pruned row, an error — must not leave
      // a live task holding the project awake. An interrupted one is the host's.
      if (!isInterrupted(task)) await release(drive, { outcome: "cancelled" });
    }
  };

  const schedulePump = (delayMs: number): void => {
    if (disposed || pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, delayMs);
  };

  /** Admit due work up to `concurrency`, oldest-due first. */
  const pump = (): void => {
    if (disposed || suspended || !db) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    pumpRun = (async () => {
      try {
        do {
          pumpAgain = false;
          if (concurrency - driving.size <= 0) break;
          const rows = await requireDb().query<{ id: string }>(
            `SELECT id FROM operations WHERE state NOT IN (${TERMINAL_SQL})
             ORDER BY next_attempt_at, created_at LIMIT ?`,
            [concurrency + driving.size]
          );
          for (const { id } of rows) {
            if (disposed || suspended || driving.size >= concurrency) break;
            if (driving.has(id)) continue;
            const entry: Drive = {
              stop: new AbortController(),
              task: null,
              released: false,
              failed: false,
              wake: () => {},
            };
            driving.set(id, entry);
            const run: Promise<void> = driveOperation(id, entry)
              .catch(() => {
                // Out of task slots, or the journal briefly unavailable: the
                // operation stays journaled and the retry timer picks it up.
                entry.failed = true;
                schedulePump(TASK_START_RETRY_MS);
              })
              .finally(() => {
                driving.delete(id);
                runs.delete(run);
                if (!entry.failed && !entry.stop.signal.aborted) pump();
              });
            runs.add(run);
          }
        } while (pumpAgain && !disposed && !suspended);
      } catch {
        schedulePump(TASK_START_RETRY_MS);
      } finally {
        pumping = false;
      }
    })();
  };

  const resume = (): void => {
    suspended = false;
    pump();
  };

  const prune = async (): Promise<number> => {
    const handle = requireDb();
    const byAge = await handle.run(
      `DELETE FROM operations WHERE state IN (${TERMINAL_SQL}) AND updated_at < ?`,
      [now() - retentionAgeMs]
    );
    const byCount = await handle.run(
      `DELETE FROM operations WHERE id IN (
         SELECT id FROM operations WHERE state IN (${TERMINAL_SQL})
         ORDER BY updated_at DESC, created_at DESC LIMIT -1 OFFSET ?
       )`,
      [retentionCount]
    );
    return byAge.changes + byCount.changes;
  };

  /** The journal open and recovered. Unlike `start`, it doesn't lift a suspension. */
  const ready = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("operation manager is disposed"));
    if (!starting) {
      const attempt = (async () => {
        const opened = await host.db.open(options.database, { migrations: MIGRATIONS });
        if (disposed) {
          await opened.close();
          throw new Error("operation manager is disposed");
        }
        db = opened;
        // The run that owned these stopped mid-call: the submit may have landed.
        await db.run(
          "UPDATE operations SET state = 'uncertain', updated_at = ? WHERE state = 'submitting'",
          [now()]
        );
        await prune();
      })();
      starting = attempt.catch(async (error: unknown) => {
        // A failed start can be tried again.
        starting = null;
        const handle = db;
        db = null;
        await handle?.close().catch(() => {});
        throw error;
      });
    }
    return starting;
  };

  const manager: OperationManager = {
    start() {
      return ready().then(resume);
    },

    async submit<Result>(kind: string, input: unknown, submitOptions: OperationSubmitOptions = {}) {
      await ready();
      const def = kindOf(kind);
      const inputJson = encodeJson(input, OPERATION_INPUT_MAX_CHARS, "operation input");
      const key = submitOptions.idempotencyKey ?? globalThis.crypto.randomUUID();
      if (
        typeof key !== "string" ||
        key.length === 0 ||
        key.length > OPERATION_IDEMPOTENCY_KEY_MAX
      ) {
        throw new RangeError(
          `idempotencyKey must be a non-empty string of at most ${OPERATION_IDEMPOTENCY_KEY_MAX} characters`
        );
      }
      const hash = await sha256Hex(`${kind}\n${canonicalJson(JSON.parse(inputJson))}`);
      const title = oneLine(String(def.title(JSON.parse(inputJson))), PLUGIN_TASK_TITLE_MAX, kind);
      const createdAt = now();
      const row = await requireDb().transaction(async (tx) => {
        const existing = await tx.get<OperationRow>(
          "SELECT * FROM operations WHERE idempotency_key = ?",
          [key]
        );
        if (existing) {
          if (existing.request_hash !== hash || existing.kind !== kind) {
            throw new OperationConflictError(existing.id);
          }
          return existing;
        }
        const unfinished = await tx.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM operations WHERE state NOT IN (${TERMINAL_SQL})`
        );
        if ((unfinished?.n ?? 0) >= maxUnfinished) throw new OperationCapacityError(maxUnfinished);
        const id = globalThis.crypto.randomUUID();
        await tx.run(
          `INSERT INTO operations (id, kind, idempotency_key, request_hash, project_id, title,
             input, state, attempt, next_attempt_at, deadline_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
          [
            id,
            kind,
            key,
            hash,
            submitOptions.projectId ?? null,
            title,
            inputJson,
            createdAt,
            createdAt + deadlineFor(kind),
            createdAt,
            createdAt,
          ]
        );
        return (await load(id, tx))!;
      });
      resume();
      return toSnapshot(row) as OperationSnapshot<Result>;
    },

    async get<Result>(id: string) {
      await ready();
      const row = await load(id);
      return row ? (toSnapshot(row) as OperationSnapshot<Result>) : undefined;
    },

    async list(filter: OperationListFilter = {}) {
      await ready();
      const where: string[] = [];
      const params: Array<string | number | null> = [];
      if (filter.projectId === null) where.push("project_id IS NULL");
      else if (filter.projectId !== undefined) {
        where.push("project_id = ?");
        params.push(filter.projectId);
      }
      if (filter.states) {
        if (filter.states.length === 0) return [];
        where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        params.push(...filter.states);
      }
      const limit = Math.min(
        OPERATION_LIST_MAX,
        Math.max(1, Math.floor(positiveNumber(filter.limit, OPERATION_LIST_MAX)))
      );
      const rows = await requireDb().query<OperationRow>(
        `SELECT * FROM operations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id LIMIT ?`,
        [...params, limit]
      );
      return rows.map(toSnapshot);
    },

    async cancel(id: string) {
      await ready();
      const handle = requireDb();
      const at = now();
      // Never sent: nothing exists remotely, so the cancel is complete now.
      await handle.run(
        `UPDATE operations SET state = 'cancelled', cancel_requested_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending' AND submitted_at IS NULL`,
        [at, at, id]
      );
      await handle.run(
        `UPDATE operations SET cancel_requested_at = ?, updated_at = ?
         WHERE id = ? AND cancel_requested_at IS NULL AND state NOT IN (${TERMINAL_SQL})`,
        [at, at, id]
      );
      driving.get(id)?.wake();
      pump();
      return manager.get(id);
    },

    async retry(id: string) {
      await ready();
      const row = await load(id);
      if (!row) return undefined;
      const at = now();
      if (row.state === "abandoned") {
        const state: OperationState =
          row.provider_id !== null
            ? "running"
            : row.submitted_at !== null
              ? "uncertain"
              : "pending";
        await requireDb().run(
          `UPDATE operations SET state = ?, generation = generation + 1, attempt = 0,
             next_attempt_at = ?, deadline_at = ?, cancel_requested_at = NULL,
             cancel_sent_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
           WHERE id = ? AND state = 'abandoned'`,
          [state, at, at + deadlineFor(row.kind), at, id]
        );
      } else if (!TERMINAL.has(row.state)) {
        await requireDb().run(
          "UPDATE operations SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND next_attempt_at > ?",
          [at, at, id, at]
        );
        driving.get(id)?.wake();
      }
      resume();
      return manager.get(id);
    },

    async abandon(id: string) {
      await ready();
      await requireDb().run(
        `UPDATE operations SET state = 'abandoned', generation = generation + 1,
           error_code = 'ABANDONED',
           error_message = 'Stopped tracking on request; the provider''s outcome is unknown',
           updated_at = ?
         WHERE id = ? AND state NOT IN (${TERMINAL_SQL})`,
        [now(), id]
      );
      driving.get(id)?.wake();
      return manager.get(id);
    },

    async prune() {
      await ready();
      return prune();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (pumpTimer) clearTimeout(pumpTimer);
      pumpTimer = null;
      for (const entry of driving.values()) entry.stop.abort();
      // The pump checks `disposed` after every await, so once it settles no
      // drive is added and `runs` is complete.
      await pumpRun;
      for (const entry of driving.values()) entry.stop.abort();
      await Promise.allSettled([...runs]);
      await starting?.catch(() => {});
      const handle = db;
      db = null;
      await handle?.close();
    },
  };

  return manager;
}

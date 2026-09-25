import { randomUUID } from "node:crypto";
import type {
  OperationId,
  OperationKind,
  OperationOutcome,
  OperationProgress,
  OperationRecord,
} from "../../../shared/types/remoteHosts.js";
import type { OperationsEvent } from "../../../shared/types/ipc/operations.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";

export const OPERATION_RETENTION_MS = 10 * 60_000;
export const OPERATION_MAX_SETTLED = 200;
export const OPERATION_PROGRESS_INTERVAL_MS = 100;
const OPERATION_ID_MAX_LENGTH = 128;
/** Joiners beyond this still share the work; only their own ids stop answering status. */
const OPERATION_MAX_ALIASES = 32;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type OperationEventEmitter = (projectId: string | null, event: OperationsEvent) => void;

export interface OperationStartInput {
  opId?: OperationId | null;
  kind: OperationKind;
  projectId?: string | null;
  /**
   * Narrows `kind` to the request that started the work (e.g. which copytree
   * channel), so an id reused for a different request is refused rather than
   * answered with another request's result.
   */
  scope?: string;
  /**
   * Identifies the work itself rather than the request. While an operation
   * with this key is running, a start with a different opId joins it instead
   * of launching a second copy.
   */
  dedupKey?: string | null;
}

export interface OperationProgressUpdate {
  fraction: number | null;
  stage: string | null;
  message: string | null;
}

export interface OperationHandle {
  readonly opId: OperationId;
  readonly signal: AbortSignal;
  progress(update: OperationProgressUpdate): void;
  /**
   * Makes the operation cancellable and hooks the request. Work that never
   * registers one can't be stopped, and `cancel` says so rather than aborting
   * a signal nothing reads.
   */
  onCancel(listener: () => void): void;
}

export interface OperationRunOptions<T> {
  /**
   * A result that reports failure in-band (rather than by throwing) settles
   * the operation as failed with this message.
   */
  failureOf?: (result: T) => string | null;
  /** An in-band result that means the work was stopped on request. */
  cancelledBy?: (result: T) => boolean;
  /** What the retained record keeps, so large payloads aren't held for minutes. */
  recordResult?: (result: T) => unknown;
}

export type OperationSettlement =
  | { status: "succeeded"; result: unknown }
  | { status: "failed"; error: { code: string | null; message: string } }
  | { status: "cancelled" };

interface Entry {
  record: OperationRecord;
  scope: string | null;
  dedupKey: string | null;
  controller: AbortController;
  cancelListeners: Array<() => void>;
  cancellable: boolean;
  promise: Promise<unknown> | null;
  aliases: Set<OperationId>;
  lastEmittedAt: number;
  lastEmittedStage: string | null;
}

export interface OperationRegistryOptions {
  emit?: OperationEventEmitter;
  now?: () => number;
  retentionMs?: number;
  maxSettled?: number;
  progressIntervalMs?: number;
}

/** A client-minted opId, or null when absent or not a well-formed id. */
export function normalizeOperationId(value: unknown): OperationId | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > OPERATION_ID_MAX_LENGTH) return null;
  return OPERATION_ID_PATTERN.test(value) ? value : null;
}

function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, reason } = error as { code?: unknown; reason?: unknown };
  if (typeof code === "string") return code;
  if (typeof reason === "string") return reason;
  return null;
}

/**
 * Host-side ledger of long mutations. A client mints the opId, so a retry
 * after a dropped link lands on the same record instead of repeating the work,
 * and a caller whose invoke never answered can ask what happened. Progress and
 * settlement are pushed to the operation's project, never to one sender.
 */
export class OperationRegistry {
  private readonly entries = new Map<OperationId, Entry>();
  private readonly aliases = new Map<OperationId, OperationId>();
  private readonly running = new Map<string, OperationId>();
  private readonly emit: OperationEventEmitter;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxSettled: number;
  private readonly progressIntervalMs: number;

  constructor(options: OperationRegistryOptions = {}) {
    this.emit = options.emit ?? (() => {});
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? OPERATION_RETENTION_MS;
    this.maxSettled = options.maxSettled ?? OPERATION_MAX_SETTLED;
    this.progressIntervalMs = options.progressIntervalMs ?? OPERATION_PROGRESS_INTERVAL_MS;
  }

  /**
   * Registers an operation, or returns the record it duplicates: the same
   * opId (running or retained), or a running operation with the same dedupKey.
   * `handle` is null for a duplicate — the caller must not start the work.
   */
  start(input: OperationStartInput): {
    record: OperationRecord;
    handle: OperationHandle | null;
  } {
    this.prune();
    const existing = this.findDuplicate(input);
    if (existing) return { record: existing.record, handle: null };

    const opId = normalizeOperationId(input.opId) ?? randomUUID();
    const entry: Entry = {
      record: {
        opId,
        kind: input.kind,
        projectId: input.projectId ?? null,
        startedAt: this.now(),
        outcome: { status: "running", progress: null },
      },
      scope: input.scope ?? null,
      dedupKey: input.dedupKey ?? null,
      controller: new AbortController(),
      cancelListeners: [],
      cancellable: false,
      promise: null,
      aliases: new Set(),
      lastEmittedAt: Number.NEGATIVE_INFINITY,
      lastEmittedStage: null,
    };
    this.entries.set(opId, entry);
    if (entry.dedupKey !== null) this.running.set(entry.dedupKey, opId);
    return { record: entry.record, handle: this.createHandle(entry) };
  }

  /**
   * Runs `work` as an operation. A duplicate start joins the original: it
   * resolves or rejects exactly as the first call did, and the work runs once.
   */
  run<T>(
    input: OperationStartInput,
    work: (handle: OperationHandle) => Promise<T>,
    options: OperationRunOptions<T> = {}
  ): Promise<T> {
    const { record, handle } = this.start(input);
    if (!handle) return this.promiseOf<T>(record.opId);

    const entry = this.entries.get(handle.opId)!;
    const promise = (async () => {
      try {
        const result = await work(handle);
        const failure = options.failureOf?.(result) ?? null;
        if (failure !== null && options.cancelledBy?.(result)) {
          this.settle(handle.opId, { status: "cancelled" });
        } else if (failure !== null) {
          this.settle(handle.opId, { status: "failed", error: { code: null, message: failure } });
        } else {
          this.settle(handle.opId, {
            status: "succeeded",
            result: options.recordResult ? options.recordResult(result) : (result ?? null),
          });
        }
        return result;
      } catch (error) {
        const code = errorCodeOf(error);
        this.settle(
          handle.opId,
          entry.controller.signal.aborted || code === "CANCELLED"
            ? { status: "cancelled" }
            : {
                status: "failed",
                error: { code, message: formatErrorMessage(error, "Operation failed") },
              }
        );
        throw error;
      }
    })();
    entry.promise = promise;
    // A retained promise nobody joins must not surface as an unhandled rejection.
    promise.catch(() => {});
    return promise;
  }

  /**
   * The outcome promise of the operation this input duplicates, or null when
   * it duplicates nothing — for a caller that must decide before doing any
   * work of its own whether to join.
   */
  join<T>(input: OperationStartInput): Promise<T> | null {
    this.prune();
    const existing = this.findDuplicate(input);
    return existing ? this.promiseOf<T>(existing.record.opId) : null;
  }

  private promiseOf<T>(opId: OperationId): Promise<T> {
    const entry = this.entries.get(opId);
    if (entry?.promise) return entry.promise as Promise<T>;
    return Promise.reject(new Error(`Operation ${opId} is not joinable`));
  }

  progress(opId: OperationId, update: OperationProgressUpdate): void {
    const entry = this.resolve(opId);
    if (!entry || entry.record.outcome.status !== "running") return;
    const progress: OperationProgress = {
      opId: entry.record.opId,
      kind: entry.record.kind,
      fraction: update.fraction === null ? null : Math.min(1, Math.max(0, update.fraction)),
      stage: update.stage,
      message: update.message,
      at: this.now(),
    };
    entry.record.outcome = { status: "running", progress };

    // The record always holds the latest; the push is paced so a chatty git
    // progress stream doesn't become an IPC storm across every project view.
    const stageChanged = update.stage !== entry.lastEmittedStage;
    if (!stageChanged && progress.at - entry.lastEmittedAt < this.progressIntervalMs) return;
    entry.lastEmittedAt = progress.at;
    entry.lastEmittedStage = update.stage;
    this.safeEmit(entry.record.projectId, { type: "progress", progress });
  }

  settle(opId: OperationId, settlement: OperationSettlement): void {
    const entry = this.resolve(opId);
    if (!entry || entry.record.outcome.status !== "running") return;
    const settledAt = this.now();
    let outcome: OperationOutcome;
    switch (settlement.status) {
      case "succeeded":
        outcome = { status: "succeeded", result: settlement.result, settledAt };
        break;
      case "failed":
        // Published to every client of the project, and git errors can echo
        // a credential-bearing remote URL.
        outcome = {
          status: "failed",
          error: { code: settlement.error.code, message: scrubSecrets(settlement.error.message) },
          settledAt,
        };
        break;
      case "cancelled":
        outcome = { status: "cancelled", settledAt };
        break;
    }
    entry.record.outcome = outcome;
    entry.cancelListeners = [];
    if (entry.dedupKey !== null && this.running.get(entry.dedupKey) === entry.record.opId) {
      this.running.delete(entry.dedupKey);
    }
    this.safeEmit(entry.record.projectId, { type: "settled", record: { ...entry.record } });
    // A joiner waits on its own id; the shared record carries the first one.
    for (const alias of entry.aliases) {
      this.safeEmit(entry.record.projectId, {
        type: "settled",
        record: { ...entry.record, opId: alias },
      });
    }
    this.prune();
  }

  status(opId: OperationId): OperationOutcome {
    this.prune();
    return this.resolve(opId)?.record.outcome ?? { status: "unknown" };
  }

  get(opId: OperationId): OperationRecord | null {
    this.prune();
    return this.resolve(opId)?.record ?? null;
  }

  list(projectId?: string | null): OperationRecord[] {
    this.prune();
    const records: OperationRecord[] = [];
    for (const entry of this.entries.values()) {
      if (projectId !== undefined && projectId !== null && entry.record.projectId !== projectId) {
        continue;
      }
      records.push({ ...entry.record });
    }
    return records.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Cancels a running operation. False when unknown, settled, or not cancellable. */
  cancel(opId: OperationId): boolean {
    const entry = this.resolve(opId);
    if (!entry || entry.record.outcome.status !== "running" || !entry.cancellable) return false;
    if (entry.controller.signal.aborted) return true;
    entry.controller.abort();
    for (const listener of entry.cancelListeners) {
      try {
        listener();
      } catch (error) {
        console.warn("[operations] cancel listener failed:", error);
      }
    }
    return true;
  }

  /** The id the work is recorded under, for a caller holding a joiner's alias. */
  canonicalId(opId: OperationId): OperationId | null {
    return this.resolve(opId)?.record.opId ?? null;
  }

  isRunning(opId: OperationId): boolean {
    return this.resolve(opId)?.record.outcome.status === "running";
  }

  private createHandle(entry: Entry): OperationHandle {
    return {
      opId: entry.record.opId,
      signal: entry.controller.signal,
      progress: (update) => this.progress(entry.record.opId, update),
      onCancel: (listener) => {
        entry.cancellable = true;
        if (entry.controller.signal.aborted) {
          listener();
          return;
        }
        entry.cancelListeners.push(listener);
      },
    };
  }

  private findDuplicate(input: OperationStartInput): Entry | null {
    const requested = normalizeOperationId(input.opId);
    if (requested) {
      const byId = this.resolve(requested);
      if (byId) {
        if (
          byId.record.kind !== input.kind ||
          byId.scope !== (input.scope ?? null) ||
          byId.record.projectId !== (input.projectId ?? null)
        ) {
          throw new Error(`Operation id ${requested} belongs to another operation`);
        }
        return byId;
      }
    }
    if (input.dedupKey) {
      const runningId = this.running.get(input.dedupKey);
      const running = runningId ? this.entries.get(runningId) : undefined;
      if (running) {
        // The joiner's own id must answer status queries for the shared work.
        if (requested && running.aliases.size < OPERATION_MAX_ALIASES) {
          running.aliases.add(requested);
          this.aliases.set(requested, running.record.opId);
        }
        return running;
      }
    }
    return null;
  }

  private resolve(opId: OperationId): Entry | undefined {
    return this.entries.get(opId) ?? this.entries.get(this.aliases.get(opId) ?? "");
  }

  private safeEmit(projectId: string | null, event: OperationsEvent): void {
    try {
      this.emit(projectId, event);
    } catch (error) {
      console.warn("[operations] event delivery failed:", error);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    const settled: Entry[] = [];
    for (const entry of this.entries.values()) {
      const { outcome } = entry.record;
      if (outcome.status === "running" || outcome.status === "unknown") continue;
      if (outcome.settledAt < cutoff) {
        this.drop(entry);
      } else {
        settled.push(entry);
      }
    }
    const overflow = settled.length - this.maxSettled;
    if (overflow <= 0) return;
    settled.sort((a, b) => settledAtOf(a) - settledAtOf(b));
    for (const entry of settled.slice(0, overflow)) this.drop(entry);
  }

  private drop(entry: Entry): void {
    this.entries.delete(entry.record.opId);
    for (const alias of entry.aliases) this.aliases.delete(alias);
  }
}

function settledAtOf(entry: Entry): number {
  const { outcome } = entry.record;
  return "settledAt" in outcome ? outcome.settledAt : 0;
}

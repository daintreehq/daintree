import { MAX_RELAY_RUN_MS } from "./linkMethods.js";

/** How long a settled call's answer is kept for a resend; past it a resend reads as unknown. */
export const RELAY_CALL_RETENTION_MS = 30 * 60_000;
/** Settled answers kept per caller at once; the oldest go first. */
export const RELAY_CALL_MAX_SETTLED = 200;
/** Bytes of settled answers kept per caller at once; the oldest go first. */
export const RELAY_CALL_MAX_SETTLED_BYTES = 8 * 1024 * 1024;
/**
 * How long a cancel for a call not yet here waits for it (#17985): past the
 * longest a Shell waits on any call, so its first send can't arrive later.
 */
export const RELAY_PENDING_CANCEL_RETENTION_MS = MAX_RELAY_RUN_MS + 60_000;
/** Cancels waiting for their call per caller at once; past it a new one is refused, never one dropped. */
export const RELAY_MAX_PENDING_CANCELS = 200;

/**
 * What a cancel did: told a running call to stop, or waits for a call not yet
 * here; `ignored` for a call that settled or another help session's; `full`
 * when its caller already has as many cancels waiting as it may.
 */
export type RelayCancelResult = "aborted" | "held" | "ignored" | "full";

export type RelayLedgerAnswer<T> =
  | { status: "answered"; value: T }
  /** A resend with no record here: it may have run and been forgotten, or never arrived. */
  | { status: "unknown" }
  /** The call id already names a different call. */
  | { status: "conflict" };

type Settlement<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface Entry<T> {
  digest: string;
  /** The help session that sent it, which alone may cancel it; none, and nothing does. */
  helpSessionId: string | undefined;
  running: Promise<T> | null;
  /** Its stop, while it runs. */
  controller: AbortController | null;
  settled: { outcome: Settlement<T>; at: number; bytes: number } | null;
}

export interface RelayCallLedgerOptions<T> {
  now?: () => number;
  retentionMs?: number;
  maxSettled?: number;
  maxSettledBytes?: number;
  /** What a settled answer costs to keep; its JSON size when absent. */
  sizeOf?: (value: T) => number;
  pendingCancelRetentionMs?: number;
  maxPendingCancels?: number;
}

function answer<T>(outcome: Settlement<T>): RelayLedgerAnswer<T> {
  if (!outcome.ok) throw outcome.error;
  return { status: "answered", value: outcome.value };
}

/**
 * At most once per call id, for the calls a host runs for a Shell (#13493).
 * The first send of an id runs its work; a send of it while that runs joins
 * it; one after it settled answers from its record, failure or not, so a lost
 * answer never makes the work run again. A resend the ledger has no record
 * of, once it was forgotten or across a restart, is never run: only a first
 * send starts anything. Each caller's records are bounded on their own, so
 * one Shell can't push out another's.
 *
 * A cancel (#17985) is for one caller's call from one help session: it stops
 * that call's work while it runs, and one that comes before its call is kept
 * until the call's first send arrives, which then starts with its stop
 * already pulled. Whatever the work answers is settled as any answer is.
 */
export class RelayCallLedger<T> {
  private readonly owners = new Map<string, Map<string, Entry<T>>>();
  /** Per caller, cancels waiting for their call, by help session and call id, with when each came. */
  private readonly pendingCancels = new Map<string, Map<string, Map<string, number>>>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxSettled: number;
  private readonly maxSettledBytes: number;
  private readonly sizeOf: (value: T) => number;
  private readonly pendingCancelRetentionMs: number;
  private readonly maxPendingCancels: number;

  constructor(options: RelayCallLedgerOptions<T> = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? RELAY_CALL_RETENTION_MS;
    this.maxSettled = options.maxSettled ?? RELAY_CALL_MAX_SETTLED;
    this.maxSettledBytes = options.maxSettledBytes ?? RELAY_CALL_MAX_SETTLED_BYTES;
    this.sizeOf =
      options.sizeOf ?? ((value) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"));
    this.pendingCancelRetentionMs =
      options.pendingCancelRetentionMs ?? RELAY_PENDING_CANCEL_RETENTION_MS;
    this.maxPendingCancels = options.maxPendingCancels ?? RELAY_MAX_PENDING_CANCELS;
  }

  /**
   * Runs `work` for a first send of `callId`, or answers from what it holds.
   * `digest` names the call itself, so an id reused for another call conflicts.
   * A `work` that throws settles as that throw, for its resends too. Its
   * signal aborts on a cancel from `helpSessionId`, the one that sent it.
   */
  async run(
    owner: string,
    callId: string,
    digest: string,
    resend: boolean,
    work: (signal: AbortSignal) => Promise<T>,
    helpSessionId?: string
  ): Promise<RelayLedgerAnswer<T>> {
    const entries = this.prune(owner);
    const existing = entries?.get(callId);
    if (existing) {
      if (existing.digest !== digest) {
        // The call that cancel was for can never run under this id now, so it can't
        // wait to stop a later one that reuses it.
        if (!resend && helpSessionId !== undefined) {
          this.takePendingCancel(owner, helpSessionId, callId);
        }
        return { status: "conflict" };
      }
      if (existing.settled) return answer(existing.settled.outcome);
      return { status: "answered", value: await existing.running! };
    }
    // A resend never starts anything, so a cancel waiting for the first send stays.
    if (resend) return { status: "unknown" };
    const controller = new AbortController();
    if (helpSessionId !== undefined && this.takePendingCancel(owner, helpSessionId, callId)) {
      controller.abort();
    }
    const entry: Entry<T> = { digest, helpSessionId, running: null, controller, settled: null };
    const owned = entries ?? new Map<string, Entry<T>>();
    owned.set(callId, entry);
    this.owners.set(owner, owned);
    // Filed before the work starts, so a resend or a cancel arriving meanwhile finds it.
    const running = (async () => work(controller.signal))();
    entry.running = running;
    // A failure is an answer too: what ran may already have changed something.
    const outcome: Settlement<T> = await running.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    entry.running = null;
    entry.controller = null;
    entry.settled = {
      outcome,
      at: this.now(),
      bytes: outcome.ok ? this.measure(outcome.value) : 0,
    };
    this.prune(owner);
    return answer(outcome);
  }

  /**
   * Stops `owner`'s call `callId` sent from `helpSessionId`: a running one is
   * told to stop, once however often it is asked, and one not yet here is
   * held so its first send starts stopped. A settled call, or one another
   * help session sent, is left as it is, its answer kept for a resend.
   */
  cancel(owner: string, helpSessionId: string, callId: string): RelayCancelResult {
    const entry = this.prune(owner)?.get(callId);
    if (entry) {
      if (entry.helpSessionId !== helpSessionId || entry.controller === null) return "ignored";
      entry.controller.abort();
      return "aborted";
    }
    const waiting = this.prunePendingCancels(owner);
    if (waiting?.get(helpSessionId)?.has(callId)) return "held";
    let count = 0;
    for (const calls of waiting?.values() ?? []) count += calls.size;
    // Dropping one already held would let its call run after its Shell was told it won't.
    if (count >= this.maxPendingCancels) return "full";
    const owned = waiting ?? new Map<string, Map<string, number>>();
    const calls = owned.get(helpSessionId) ?? new Map<string, number>();
    calls.set(callId, this.now());
    owned.set(helpSessionId, calls);
    this.pendingCancels.set(owner, owned);
    return "held";
  }

  /** Records held across every caller, running ones included. */
  get size(): number {
    let count = 0;
    for (const entries of this.owners.values()) count += entries.size;
    return count;
  }

  /** Cancels held across every caller, waiting for their call. */
  get pendingCancelCount(): number {
    let count = 0;
    for (const owned of this.pendingCancels.values()) {
      for (const calls of owned.values()) count += calls.size;
    }
    return count;
  }

  /** Drops every caller's expired records, so a Shell that never calls again keeps none. */
  sweep(): void {
    for (const owner of [...this.owners.keys()]) this.prune(owner);
    for (const owner of [...this.pendingCancels.keys()]) this.prunePendingCancels(owner);
  }

  /** Forgets everything; used when the host stops serving relayed calls. */
  clear(): void {
    this.owners.clear();
    this.pendingCancels.clear();
  }

  private takePendingCancel(owner: string, helpSessionId: string, callId: string): boolean {
    const owned = this.prunePendingCancels(owner);
    const calls = owned?.get(helpSessionId);
    if (!calls?.delete(callId)) return false;
    if (calls.size === 0) owned!.delete(helpSessionId);
    if (owned!.size === 0) this.pendingCancels.delete(owner);
    return true;
  }

  private prunePendingCancels(owner: string): Map<string, Map<string, number>> | undefined {
    const owned = this.pendingCancels.get(owner);
    if (!owned) return undefined;
    const cutoff = this.now() - this.pendingCancelRetentionMs;
    for (const [helpSessionId, calls] of owned) {
      for (const [callId, at] of calls) {
        if (at < cutoff) calls.delete(callId);
      }
      if (calls.size === 0) owned.delete(helpSessionId);
    }
    if (owned.size === 0) {
      this.pendingCancels.delete(owner);
      return undefined;
    }
    return owned;
  }

  private measure(value: T): number {
    try {
      return this.sizeOf(value);
    } catch {
      return this.maxSettledBytes;
    }
  }

  /** Drops expired and over-budget settled records, never one still running. */
  private prune(owner: string): Map<string, Entry<T>> | undefined {
    const entries = this.owners.get(owner);
    if (!entries) return undefined;
    const now = this.now();
    let count = 0;
    let bytes = 0;
    for (const [callId, entry] of entries) {
      if (entry.settled && now - entry.settled.at > this.retentionMs) {
        entries.delete(callId);
        continue;
      }
      if (entry.settled) {
        count += 1;
        bytes += entry.settled.bytes;
      }
    }
    // Oldest first: a Map iterates in insertion order, which is when each call started.
    for (const [callId, entry] of entries) {
      if (count <= this.maxSettled && bytes <= this.maxSettledBytes) break;
      if (!entry.settled) continue;
      entries.delete(callId);
      count -= 1;
      bytes -= entry.settled.bytes;
    }
    if (entries.size === 0) {
      this.owners.delete(owner);
      return undefined;
    }
    return entries;
  }
}

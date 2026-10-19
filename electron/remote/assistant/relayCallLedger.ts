/** How long a settled call's answer is kept for a resend; past it a resend reads as unknown. */
export const RELAY_CALL_RETENTION_MS = 30 * 60_000;
/** Settled answers kept per caller at once; the oldest go first. */
export const RELAY_CALL_MAX_SETTLED = 200;
/** Bytes of settled answers kept per caller at once; the oldest go first. */
export const RELAY_CALL_MAX_SETTLED_BYTES = 8 * 1024 * 1024;

export type RelayLedgerAnswer<T> =
  | { status: "answered"; value: T }
  /** A resend with no record here: it may have run and been forgotten, or never arrived. */
  | { status: "unknown" }
  /** The call id already names a different call. */
  | { status: "conflict" };

type Settlement<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface Entry<T> {
  digest: string;
  running: Promise<T> | null;
  settled: { outcome: Settlement<T>; at: number; bytes: number } | null;
}

export interface RelayCallLedgerOptions<T> {
  now?: () => number;
  retentionMs?: number;
  maxSettled?: number;
  maxSettledBytes?: number;
  /** What a settled answer costs to keep; its JSON size when absent. */
  sizeOf?: (value: T) => number;
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
 */
export class RelayCallLedger<T> {
  private readonly owners = new Map<string, Map<string, Entry<T>>>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxSettled: number;
  private readonly maxSettledBytes: number;
  private readonly sizeOf: (value: T) => number;

  constructor(options: RelayCallLedgerOptions<T> = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? RELAY_CALL_RETENTION_MS;
    this.maxSettled = options.maxSettled ?? RELAY_CALL_MAX_SETTLED;
    this.maxSettledBytes = options.maxSettledBytes ?? RELAY_CALL_MAX_SETTLED_BYTES;
    this.sizeOf =
      options.sizeOf ?? ((value) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"));
  }

  /**
   * Runs `work` for a first send of `callId`, or answers from what it holds.
   * `digest` names the call itself, so an id reused for another call conflicts.
   * A `work` that throws settles as that throw, for its resends too.
   */
  async run(
    owner: string,
    callId: string,
    digest: string,
    resend: boolean,
    work: () => Promise<T>
  ): Promise<RelayLedgerAnswer<T>> {
    const entries = this.prune(owner);
    const existing = entries?.get(callId);
    if (existing) {
      if (existing.digest !== digest) return { status: "conflict" };
      if (existing.settled) return answer(existing.settled.outcome);
      return { status: "answered", value: await existing.running! };
    }
    if (resend) return { status: "unknown" };
    const entry: Entry<T> = { digest, running: null, settled: null };
    const owned = entries ?? new Map<string, Entry<T>>();
    owned.set(callId, entry);
    this.owners.set(owner, owned);
    // Filed before the work starts, so a resend arriving meanwhile joins it.
    const running = (async () => work())();
    entry.running = running;
    // A failure is an answer too: what ran may already have changed something.
    const outcome: Settlement<T> = await running.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    entry.running = null;
    entry.settled = {
      outcome,
      at: this.now(),
      bytes: outcome.ok ? this.measure(outcome.value) : 0,
    };
    this.prune(owner);
    return answer(outcome);
  }

  /** Records held across every caller, running ones included. */
  get size(): number {
    let count = 0;
    for (const entries of this.owners.values()) count += entries.size;
    return count;
  }

  /** Drops every caller's expired records, so a Shell that never calls again keeps none. */
  sweep(): void {
    for (const owner of [...this.owners.keys()]) this.prune(owner);
  }

  /** Forgets everything; used when the host stops serving relayed calls. */
  clear(): void {
    this.owners.clear();
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

import {
  getLeaseInputBlock,
  getTerminalInputBlock,
  subscribeTerminalInputGate,
} from "@/services/terminal/inputGate";
import { isClientAppError } from "@/utils/clientAppError";
import { logDebug } from "@/utils/logger";

/**
 * Background saves of the project state a host owns (the active worktree, the
 * MRU list, the panel list, tab groups, drafts, focus mode) from a view that
 * may not be allowed to make them, or may not be able to reach the host.
 *
 * - While another screen drives the project, nothing is sent: the host would
 *   refuse it, and the driver's state is the project's. A refusal that arrives
 *   anyway (the lease moved before this view heard) is expected, not a failure.
 * - While the link is down or this view doesn't yet know who drives, the latest
 *   write per key is held and replayed once the link is back and this view
 *   still drives; a write the link lost on the way is held the same way. A
 *   takeover by someone else drops what was held, since the rehydrate that
 *   follows reads the host's state as authoritative.
 *
 * A view that never had a host or a lease sees no block at all, so every write
 * goes straight out and its errors reach the caller exactly as before.
 */
export type HostOwnedWriteOutcome = "sent" | "deferred" | "skipped";

type Replay = () => void;

const deferred = new Map<string, Replay>();
/** Per key, bumped by every call, so only the newest call's lost write is held. */
const callSeq = new Map<string, number>();
let unsubscribeGate: (() => void) | null = null;
let flushBarrier: (() => Promise<void>) | null = null;
let flushScheduled = false;
/**
 * One flush may follow a write lost while the gate already looked open (the
 * link dropped and came back before its failure arrived). Rearmed only by a
 * gate change, so a host that keeps answering "disconnected" can't loop.
 */
let lostWriteFlushArmed = true;
/**
 * Bumped whenever this view learns the host's copy may have moved without it:
 * another screen drives the project, or everything held was dropped. A write
 * that started before is never held afterwards, and callers that remember what
 * they last saved stop trusting that memory.
 */
let hostStateEpoch = 0;
let gateSubscribed = false;

type Verdict = "send" | "defer" | "skip";

function verdict(): Verdict {
  if (getLeaseInputBlock()?.kind === "driven-elsewhere") return "skip";
  return getTerminalInputBlock() === null ? "send" : "defer";
}

function refusalCode(error: unknown): "driven-elsewhere" | "unreached" | null {
  if (!isClientAppError(error)) return null;
  if (error.code === "DRIVEN_ELSEWHERE") return "driven-elsewhere";
  if (error.code === "HOST_DISCONNECTED" || error.code === "OUTCOME_UNKNOWN") return "unreached";
  return null;
}

function watchGate(): void {
  if (gateSubscribed) return;
  gateSubscribed = true;
  unsubscribeGate = subscribeTerminalInputGate(onGateChange);
}

function hold(key: string, replay: Replay): void {
  deferred.set(key, replay);
}

function onGateChange(): void {
  lostWriteFlushArmed = true;
  const next = verdict();
  if (next === "skip") dropDeferredHostOwnedWrites("another screen drives the project");
  else if (next === "send" && deferred.size > 0) scheduleFlush();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const barrier = flushBarrier;
  void (async () => {
    try {
      // The host connection sync refreshes the lease and lets a fresh
      // session's rehydrate finish first, so nothing held here lands on top
      // of it.
      await barrier?.();
    } catch {
      // A barrier that fails says nothing new; the gate is re-read below.
    } finally {
      flushScheduled = false;
    }
    flushDeferredHostOwnedWrites();
  })();
}

/**
 * Save host-owned state through `send`, or hold it: `replay` re-enters the
 * caller's own save path with the value this call wanted, so a replay is
 * gated, deduplicated and baselined like any other save. Any error other than
 * a lease refusal or a lost link is thrown for the caller to report.
 */
export async function sendHostOwnedWrite(
  key: string,
  send: () => Promise<unknown>,
  replay: Replay
): Promise<HostOwnedWriteOutcome> {
  watchGate();
  // This call is newer than anything held or in flight for the key.
  supersedeDeferredHostOwnedWrite(key);
  const seq = callSeq.get(key)!;
  const epoch = hostStateEpoch;
  const now = verdict();
  if (now === "skip") return "skipped";
  if (now === "defer") {
    hold(key, replay);
    return "deferred";
  }
  try {
    await send();
    return "sent";
  } catch (error) {
    const refusal = refusalCode(error);
    if (refusal === null) throw error;
    if (refusal === "driven-elsewhere") {
      logDebug("[HostOwnedWrites] Host refused a save: another screen drives the project", {
        key,
      });
      dropDeferredHostOwnedWrites("the host refused a save");
      return "skipped";
    }
    logDebug("[HostOwnedWrites] Holding a save until the host link is back", { key });
    // Only the newest call's write is held, and never one that started
    // before a takeover or a drop: the host's state is the project's then.
    if (callSeq.get(key) === seq && epoch === hostStateEpoch && !deferred.has(key)) {
      hold(key, replay);
      if (verdict() === "send" && lostWriteFlushArmed) {
        lostWriteFlushArmed = false;
        scheduleFlush();
      }
    }
    return "deferred";
  }
}

/**
 * A newer value for `key` is being saved, or turned out to be what the host
 * already has: nothing held for it, nor any older write still in flight, may
 * be replayed over it.
 */
export function supersedeDeferredHostOwnedWrite(key: string): void {
  callSeq.set(key, (callSeq.get(key) ?? 0) + 1);
  deferred.delete(key);
}

/**
 * Changes whenever what this view last saved may no longer be what the host
 * holds (another screen drove the project meanwhile). A caller that skips a
 * save because it matches its last acknowledged one should compare this too.
 */
export function getHostOwnedStateEpoch(): number {
  return hostStateEpoch;
}

/** Replay everything held, if this view may drive and reach the host now. */
export function flushDeferredHostOwnedWrites(): void {
  if (deferred.size === 0) return;
  const now = verdict();
  if (now === "skip") {
    dropDeferredHostOwnedWrites("another screen drives the project");
    return;
  }
  if (now === "defer") return;
  const replays = [...deferred.values()];
  deferred.clear();
  for (const replay of replays) {
    try {
      replay();
    } catch (error) {
      logDebug("[HostOwnedWrites] A held save couldn't be replayed", { error });
    }
  }
}

/** Forget everything held: the host's state is the project's now. */
export function dropDeferredHostOwnedWrites(reason: string): void {
  hostStateEpoch += 1;
  if (deferred.size === 0) return;
  logDebug("[HostOwnedWrites] Dropping held saves", { reason, count: deferred.size });
  deferred.clear();
}

/**
 * What a flush waits on before replaying: set by the host connection sync to
 * refresh the lease and wait out a resync in flight. Returns the unregister.
 */
export function setHostOwnedWriteFlushBarrier(barrier: () => Promise<void>): () => void {
  flushBarrier = barrier;
  return () => {
    if (flushBarrier === barrier) flushBarrier = null;
  };
}

export function hasDeferredHostOwnedWrite(key: string): boolean {
  return deferred.has(key);
}

export function _resetHostOwnedWritesForTesting(): void {
  deferred.clear();
  callSeq.clear();
  unsubscribeGate?.();
  unsubscribeGate = null;
  gateSubscribed = false;
  hostStateEpoch = 0;
  flushBarrier = null;
  flushScheduled = false;
  lostWriteFlushArmed = true;
}

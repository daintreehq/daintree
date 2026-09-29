import type { PtyClient } from "./PtyClient.js";

type TerminalSnapshot = Awaited<ReturnType<PtyClient["getAllTerminalsWithCompletenessAsync"]>>;

/**
 * Long enough to cover the stats and fleet pollers landing on the same aligned
 * tick, short enough that an unsignalled change (spawn, exit) is no staler than
 * one poll either way.
 */
const SNAPSHOT_TTL_MS = 1_000;

interface CacheEntry {
  snapshot: TerminalSnapshot | null;
  /** When the request that produced `snapshot` was sent — its sample age, not its arrival. */
  sampledAt: number;
  inFlight: Promise<TerminalSnapshot> | null;
  inFlightSentAt: number;
  generation: number;
}

// Keyed by client so each test's double (and a respawned client) starts cold.
const cache = new WeakMap<PtyClient, CacheEntry>();

function entryFor(ptyClient: PtyClient): CacheEntry {
  let entry = cache.get(ptyClient);
  if (!entry) {
    entry = { snapshot: null, sampledAt: 0, inFlight: null, inFlightSentAt: 0, generation: 0 };
    cache.set(ptyClient, entry);
  }
  return entry;
}

function isFresh(sentAt: number, now: number): boolean {
  const age = now - sentAt;
  // Negative age = the clock moved backwards (suspend correction, fake timers).
  return age >= 0 && age <= SNAPSHOT_TTL_MS;
}

/**
 * One `get-all-terminals` fan-out shared by the background pollers
 * (`ProjectStatsService`, `FleetSnapshotService`), which used to each fan out
 * on the same aligned 5s tick and again 200ms after every agent transition.
 *
 * Age is measured from when a request was SENT, for settled and in-flight
 * reads alike: a request held up by a slow shard is as old as it was when it
 * left, so a later poll starts its own rather than inheriting a stale sample.
 *
 * Only for callers that tolerate a read up to {@link SNAPSHOT_TTL_MS} old and
 * that invalidate on the events they react to. Anything reading straight after
 * a mutation it made itself must call `getAllTerminalsWithCompletenessAsync`
 * directly — joining a request that left before the mutation would hand it the
 * pre-mutation world.
 */
export function getSharedTerminalSnapshot(ptyClient: PtyClient): Promise<TerminalSnapshot> {
  const entry = entryFor(ptyClient);
  const now = Date.now();
  if (entry.snapshot !== null && isFresh(entry.sampledAt, now)) {
    return Promise.resolve(entry.snapshot);
  }
  if (entry.inFlight && isFresh(entry.inFlightSentAt, now)) return entry.inFlight;

  // Superseding a stale in-flight read retires it, so it cannot land in the
  // cache over the newer one.
  const generation = ++entry.generation;
  const sentAt = now;
  const request = ptyClient.getAllTerminalsWithCompletenessAsync().then((snapshot) => {
    // A degraded read is never reused: the next poller retries the shard
    // rather than inheriting a hole from its sibling.
    if (entry.generation === generation && !snapshot.degraded) {
      entry.snapshot = snapshot;
      entry.sampledAt = sentAt;
    }
    return snapshot;
  });
  entry.inFlight = request;
  entry.inFlightSentAt = sentAt;
  const clear = () => {
    if (entry.inFlight === request) entry.inFlight = null;
  };
  request.then(clear, clear);
  return request;
}

/**
 * Drop the cached read and detach any request in flight, so the next caller
 * issues a fresh one. Called on every event the pollers recompute for: a read
 * that left before the event may not reflect it.
 */
export function invalidateSharedTerminalSnapshot(ptyClient: PtyClient | null | undefined): void {
  if (!ptyClient) return;
  const entry = cache.get(ptyClient);
  if (!entry) return;
  entry.generation++;
  entry.snapshot = null;
  entry.inFlight = null;
}

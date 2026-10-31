/**
 * The Shell's one record of a repository's issue/PR counts, shared by every
 * view of that repository on every host this machine's windows visit
 * (#14199, #15546).
 *
 * Each host polls with its own token and persists its own counts, keyed by its
 * own project path, so without this a window switched between hosts shows each
 * host's own numbers. Every project view — local or remote — runs on the
 * `persist:daintree` partition with the same document origin, so
 * `localStorage` is the one place they all read, and its `storage` event
 * reaches every other view in every window. Nothing here reaches a host.
 *
 * Records are keyed by repository origin alone (`forge-host/owner/repo`): the
 * forge account a host is signed in as doesn't split them. Each host writes
 * its own entry and readers take the newest, so views in different renderer
 * processes never race on one slot. "Newest" is the order this Shell received
 * the readings in, on its own clock: each host stamps its counts on its own
 * clock, and a host whose clock runs ahead would otherwise outrank every fresh
 * poll from the others. A reading the host served from its cache was made
 * before it arrived, so it is dated by when the host made it instead.
 *
 * Every storage access is best-effort — a blocked or full store reads as empty.
 */

const RECORD_PREFIX = "daintree:repo-stats:origin:";

// A stamp ahead of this Shell's clock (it stepped back since) would outrank
// every real reading until the clock caught up; one this far ahead is junk.
const MAX_CLOCK_LEAD_MS = 24 * 60 * 60 * 1000;

// A host's own clock orders its readings for only this long: one corrected
// after running ahead would otherwise have every reading refused until it
// caught up.
const HOST_CLOCK_TRUST_MS = 5 * 60 * 1000;

export interface SharedRepoStats {
  issueCount: number | null;
  prCount: number | null;
  /**
   * When this Shell received the reading, on its own clock — for a cache replay,
   * when the host made it. Orders the entries.
   */
  receivedAt: number;
  /** When each count was read from the forge, moved onto this Shell's clock. */
  issueObservedAt: number;
  prObservedAt: number;
  /**
   * The reporting host's `lastUpdated`, on its own clock, so a host never
   * republishes a reading it already published (the poll's own answer and its
   * broadcast) or replaces it with an older one.
   */
  sourceUpdatedAt: number;
  /** Host that made the reading (`local` for this machine). */
  hostId: string;
}

function recordScope(repoKey: string): string {
  // The JSON array minus its closing bracket, so every host's entry for one
  // origin shares this exact prefix.
  return `${RECORD_PREFIX}${JSON.stringify([repoKey]).slice(0, -1)},`;
}

function recordKey(repoKey: string, hostId: string): string {
  return `${recordScope(repoKey)}${JSON.stringify(hostId)}]`;
}

function readJson(key: string): unknown {
  try {
    // storage-key: daintree:repo-stats:origin:
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    // storage-key: daintree:repo-stats:origin:
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota or blocked storage: each view falls back to its host's own counts.
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseRecord(v: unknown): SharedRepoStats | null {
  if (!isPlainRecord(v)) return null;
  if (!isCount(v.issueCount) || !isCount(v.prCount)) return null;
  if (!isTime(v.receivedAt) || !isTime(v.issueObservedAt) || !isTime(v.prObservedAt)) return null;
  if (!isTime(v.sourceUpdatedAt) || typeof v.hostId !== "string") return null;
  const limit = Date.now() + MAX_CLOCK_LEAD_MS;
  if (v.receivedAt > limit || v.issueObservedAt > limit || v.prObservedAt > limit) return null;
  return {
    issueCount: v.issueCount,
    prCount: v.prCount,
    receivedAt: v.receivedAt,
    issueObservedAt: v.issueObservedAt,
    prObservedAt: v.prObservedAt,
    sourceUpdatedAt: v.sourceUpdatedAt,
    hostId: v.hostId,
  };
}

function newer(a: SharedRepoStats, b: SharedRepoStats): boolean {
  // Host id breaks a tie, so every view picks the same entry.
  return a.receivedAt !== b.receivedAt ? a.receivedAt > b.receivedAt : a.hostId > b.hostId;
}

/** The origin's record: the newest reading any host made of it, as this Shell received them. */
export function readSharedRepoStats(repoKey: string): SharedRepoStats | null {
  const scope = recordScope(repoKey);
  let newest: SharedRepoStats | null = null;
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || !key.startsWith(scope)) continue;
      const record = parseRecord(readJson(key));
      if (record && (newest === null || newer(record, newest))) newest = record;
    }
  } catch {
    return null;
  }
  return newest;
}

export interface SharedRepoReading {
  issueCount: number | null;
  prCount: number | null;
  /** The host's `lastUpdated` for the answer, on its clock. */
  lastUpdated: number;
  /** When the host last read each count, on its clock. */
  issueRefreshedAt: number;
  prRefreshedAt: number;
  hostId: string;
  /** Served from the host's cache: made before it arrived, possibly long before. */
  replay?: boolean;
}

const localListeners = new Map<string, Set<() => void>>();

/**
 * Record a host's fresh reading as the origin's newest, unless that host
 * already published it or a later one. Returns whether it was written.
 */
export function publishSharedRepoStats(
  repoKey: string,
  reading: SharedRepoReading,
  now: number = Date.now()
): boolean {
  if (!isTime(reading.lastUpdated) || !isCount(reading.issueCount) || !isCount(reading.prCount)) {
    return false;
  }
  const key = recordKey(repoKey, reading.hostId);
  const existing = parseRecord(readJson(key));
  if (
    existing &&
    existing.sourceUpdatedAt >= reading.lastUpdated &&
    now - existing.receivedAt < HOST_CLOCK_TRUST_MS
  ) {
    return false;
  }
  let receivedAt = now;
  if (reading.replay) {
    if (existing) {
      // The host's last entry says how its clock sits against this one.
      const offset = existing.receivedAt - existing.sourceUpdatedAt;
      receivedAt = Math.max(1, Math.min(now, reading.lastUpdated + offset));
    } else if (readSharedRepoStats(repoKey) !== null) {
      // Nothing to date it by: it may be older than what the others reported.
      return false;
    }
  }
  // How old each count was when the host made the reading, measured on its own
  // clock and carried onto this one.
  const ageOf = (refreshedAt: number) => Math.max(0, reading.lastUpdated - refreshedAt);
  const record: SharedRepoStats = {
    issueCount: reading.issueCount,
    prCount: reading.prCount,
    receivedAt,
    issueObservedAt: Math.max(1, receivedAt - ageOf(reading.issueRefreshedAt)),
    prObservedAt: Math.max(1, receivedAt - ageOf(reading.prRefreshedAt)),
    sourceUpdatedAt: reading.lastUpdated,
    hostId: reading.hostId,
  };
  if (!writeJson(key, record)) return false;
  // The `storage` event reaches every other document; views in this one hear
  // it here.
  for (const listener of [...(localListeners.get(repoKey) ?? [])]) listener();
  return true;
}

/**
 * Call `listener` whenever any view, in any window, may have changed the
 * origin's record. It re-reads the store rather than trusting the event.
 */
export function subscribeSharedRepoStats(repoKey: string, listener: () => void): () => void {
  const scope = recordScope(repoKey);
  const onStorage = (event: StorageEvent) => {
    // A null key is the whole store being cleared.
    if (event.key !== null && !event.key.startsWith(scope)) return;
    listener();
  };
  let listeners = localListeners.get(repoKey);
  if (!listeners) {
    listeners = new Set();
    localListeners.set(repoKey, listeners);
  }
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    const current = localListeners.get(repoKey);
    current?.delete(listener);
    if (current?.size === 0) localListeners.delete(repoKey);
  };
}

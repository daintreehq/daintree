/**
 * Device-shared newest observation of a repository's issue/PR counts, across
 * every host this machine's windows visit (issue #14199).
 *
 * Each host polls with its own token and persists its own counts, keyed by its
 * own project path, so a window switched to a host that hasn't polled in a
 * while seeds from that host's old snapshot and then jumps. Every project view
 * — local or remote — runs on the `persist:daintree` partition with the same
 * document origin, so `localStorage` is the one place they all read. This is a
 * display hint only: nothing here reaches a host, and the host's own poll is
 * still what reconciles the toolbar.
 *
 * Observations are keyed by provider, account and repository: counts belong to
 * the provider that reported them (#10761), and two accounts can legitimately
 * see different numbers for the same repo. Each host writes its own entry and
 * readers take the newest, so views in different renderer processes never race
 * on one slot. Aliases map a host's project path to the repository key its last
 * fresh poll reported, so a view can find the observation before its own poll
 * answers.
 *
 * Every storage access is best-effort — a blocked or full store reads as empty.
 */

const OBSERVATION_PREFIX = "daintree:repo-stats:obs:";
const ALIAS_PREFIX = "daintree:repo-stats:alias:";

// Observation times come from each host's clock; one far in the future would
// outrank every real observation forever.
const MAX_CLOCK_LEAD_MS = 24 * 60 * 60 * 1000;

export interface SharedRepoObservation {
  issueCount: number | null;
  prCount: number | null;
  /** When the reporting host last read these counts from the forge, epoch ms. */
  observedAt: number;
  /** Host that made the observation (`local` for this machine). */
  hostId: string;
}

export interface SharedRepoAlias {
  providerId: string;
  repoKey: string;
}

function observationScope(providerId: string, account: string, repoKey: string): string {
  // The JSON array minus its closing bracket, so every host's entry for one
  // repo shares this exact prefix.
  return `${OBSERVATION_PREFIX}${JSON.stringify([providerId, account, repoKey]).slice(0, -1)},`;
}

function observationKey(
  providerId: string,
  account: string,
  repoKey: string,
  hostId: string
): string {
  return `${observationScope(providerId, account, repoKey)}${JSON.stringify(hostId)}]`;
}

function aliasKey(hostId: string, projectPath: string): string {
  return `${ALIAS_PREFIX}${JSON.stringify([hostId, projectPath])}`;
}

function readJson(key: string): unknown {
  try {
    // storage-key: daintree:repo-stats:obs: daintree:repo-stats:alias:
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    // storage-key: daintree:repo-stats:obs: daintree:repo-stats:alias:
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: the toolbar falls back to the host's own seed.
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

function isObservedAt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= Date.now() + MAX_CLOCK_LEAD_MS
  );
}

function parseObservation(v: unknown): SharedRepoObservation | null {
  if (!isPlainRecord(v)) return null;
  if (!isCount(v.issueCount) || !isCount(v.prCount)) return null;
  if (!isObservedAt(v.observedAt) || typeof v.hostId !== "string") return null;
  return {
    issueCount: v.issueCount,
    prCount: v.prCount,
    observedAt: v.observedAt,
    hostId: v.hostId,
  };
}

/** The newest observation of a repo made by any host other than `excludeHostId`. */
export function readNewestSharedObservation(
  providerId: string,
  account: string,
  repoKey: string,
  excludeHostId: string
): SharedRepoObservation | null {
  const scope = observationScope(providerId, account, repoKey);
  const own = observationKey(providerId, account, repoKey, excludeHostId);
  let newest: SharedRepoObservation | null = null;
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || key === own || !key.startsWith(scope)) continue;
      const observation = parseObservation(readJson(key));
      if (observation && (newest === null || observation.observedAt > newest.observedAt)) {
        newest = observation;
      }
    }
  } catch {
    return null;
  }
  return newest;
}

/** Record this host's observation unless its entry already holds one at least as new. */
export function publishSharedObservation(
  providerId: string,
  account: string,
  repoKey: string,
  observation: SharedRepoObservation
): void {
  if (parseObservation(observation) === null) return;
  const key = observationKey(providerId, account, repoKey, observation.hostId);
  const existing = parseObservation(readJson(key));
  if (existing && existing.observedAt >= observation.observedAt) return;
  writeJson(key, observation);
}

export function readRepoAlias(hostId: string, projectPath: string): SharedRepoAlias | null {
  const v = readJson(aliasKey(hostId, projectPath));
  if (!isPlainRecord(v)) return null;
  if (typeof v.providerId !== "string" || typeof v.repoKey !== "string") return null;
  return { providerId: v.providerId, repoKey: v.repoKey };
}

export function writeRepoAlias(hostId: string, projectPath: string, alias: SharedRepoAlias): void {
  const existing = readRepoAlias(hostId, projectPath);
  if (existing?.providerId === alias.providerId && existing.repoKey === alias.repoKey) return;
  writeJson(aliasKey(hostId, projectPath), alias);
}

/** Forget a project's repository, once its counts no longer come from one repo. */
export function clearRepoAlias(hostId: string, projectPath: string): void {
  try {
    // storage-key: daintree:repo-stats:obs: daintree:repo-stats:alias:
    window.localStorage.removeItem(aliasKey(hostId, projectPath));
  } catch {
    // Blocked storage holds no alias to clear.
  }
}

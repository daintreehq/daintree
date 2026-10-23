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
 * see different numbers for the same repo. Aliases map a host's project path to
 * the repository key its last fresh poll reported, so a view can find the
 * observation before its own poll answers.
 *
 * Every storage access is best-effort — a blocked or full store reads as empty.
 */

const OBSERVATION_PREFIX = "daintree:repo-stats:obs:";
const ALIAS_PREFIX = "daintree:repo-stats:alias:";

export interface SharedRepoObservation {
  issueCount: number | null;
  prCount: number | null;
  /** The reporting host's `lastUpdated` for these counts, epoch ms. */
  observedAt: number;
  /** Host that made the observation (`local` for this machine). */
  hostId: string;
}

export interface SharedRepoAlias {
  providerId: string;
  repoKey: string;
}

function observationKey(providerId: string, account: string, repoKey: string): string {
  return `${OBSERVATION_PREFIX}${JSON.stringify([providerId, account, repoKey])}`;
}

function aliasKey(hostId: string, projectPath: string): string {
  return `${ALIAS_PREFIX}${JSON.stringify([hostId, projectPath])}`;
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: the toolbar falls back to the host's own seed.
  }
}

function isCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function readSharedObservation(
  providerId: string,
  account: string,
  repoKey: string
): SharedRepoObservation | null {
  const value = readJson(observationKey(providerId, account, repoKey));
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.issueCount) || !isCount(v.prCount)) return null;
  if (typeof v.observedAt !== "number" || !Number.isFinite(v.observedAt)) return null;
  if (typeof v.hostId !== "string") return null;
  return {
    issueCount: v.issueCount,
    prCount: v.prCount,
    observedAt: v.observedAt,
    hostId: v.hostId,
  };
}

/** Record an observation unless one at least as new is already stored. */
export function publishSharedObservation(
  providerId: string,
  account: string,
  repoKey: string,
  observation: SharedRepoObservation
): void {
  const existing = readSharedObservation(providerId, account, repoKey);
  if (existing && existing.observedAt >= observation.observedAt) return;
  writeJson(observationKey(providerId, account, repoKey), observation);
}

export function readRepoAlias(hostId: string, projectPath: string): SharedRepoAlias | null {
  const value = readJson(aliasKey(hostId, projectPath));
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.providerId !== "string" || typeof v.repoKey !== "string") return null;
  return { providerId: v.providerId, repoKey: v.repoKey };
}

export function writeRepoAlias(hostId: string, projectPath: string, alias: SharedRepoAlias): void {
  const existing = readRepoAlias(hostId, projectPath);
  if (existing?.providerId === alias.providerId && existing.repoKey === alias.repoKey) return;
  writeJson(aliasKey(hostId, projectPath), alias);
}

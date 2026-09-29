import { app } from "electron";
import { store } from "../store.js";
import type { VersionFirstRunBoundary } from "../../shared/types/ipc/system.js";

/**
 * Persisted "first launch on this version" record. `firstRunAtMs` is null for
 * a baseline: the version was already running when recording began (first
 * build shipping this, or a fresh profile), so its real first launch is
 * unknown and no boundary is offered until the next version change.
 */
export interface VersionFirstRunRecord {
  version: string;
  firstRunAtMs: number | null;
}

function parseRecord(raw: unknown): VersionFirstRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, firstRunAtMs } = raw as { version?: unknown; firstRunAtMs?: unknown };
  if (typeof version !== "string" || version === "") return null;
  if (firstRunAtMs === null) return { version, firstRunAtMs: null };
  if (typeof firstRunAtMs === "number" && Number.isFinite(firstRunAtMs) && firstRunAtMs > 0) {
    return { version, firstRunAtMs };
  }
  return null;
}

/**
 * Returns the record to persist for this boot, or null when the stored one is
 * already current. Versions are compared as plain strings rather than semver:
 * a downgrade or a nightly→stable move is still a different build to triage.
 */
export function resolveVersionFirstRun(
  stored: unknown,
  currentVersion: string,
  nowMs: number
): VersionFirstRunRecord | null {
  const previous = parseRecord(stored);
  if (!previous) return { version: currentVersion, firstRunAtMs: null };
  if (previous.version === currentVersion) return null;
  return { version: currentVersion, firstRunAtMs: nowMs };
}

/**
 * The boundary for the running version, or null when it isn't known. A
 * boundary in the future (clock moved backwards since) would filter out every
 * log, so it's treated as unknown too.
 */
export function toVersionFirstRunBoundary(
  stored: unknown,
  currentVersion: string,
  nowMs: number
): VersionFirstRunBoundary | null {
  const record = parseRecord(stored);
  if (!record || record.version !== currentVersion || record.firstRunAtMs === null) return null;
  if (record.firstRunAtMs > nowMs) return null;
  return { version: record.version, firstRunAtMs: record.firstRunAtMs };
}

/**
 * Runs once per boot on every install path (auto-updater, DMG, Homebrew,
 * Windows Store, dev), so it can't live in the packaged-only AutoUpdaterService.
 */
export function recordVersionFirstRun(nowMs: number = Date.now()): void {
  const next = resolveVersionFirstRun(store.get("versionFirstRun"), app.getVersion(), nowMs);
  if (next) store.set("versionFirstRun", next);
}

/** Never throws: a settings read failure must not block exporting diagnostics. */
export function getVersionFirstRunBoundary(
  nowMs: number = Date.now()
): VersionFirstRunBoundary | null {
  try {
    return toVersionFirstRunBoundary(store.get("versionFirstRun"), app.getVersion(), nowMs);
  } catch {
    return null;
  }
}

/**
 * The open-window manifest: which project each window was showing when the app
 * last ran, so a relaunch can rebuild the whole set instead of one window
 * (#11492).
 *
 * Stored as a single JSON value under `app_state.openWindows`, alongside the
 * `currentProjectId` scalar ProjectStore already keeps there. That table is a
 * schemaless key/value store, so this needs no drizzle migration.
 *
 * NOT to be confused with `electron/store.ts`'s unrelated top-level `appState`
 * key — same name, different engine (electron-store JSON vs. SQLite).
 *
 * Records are ordered most-recently-focused first. Order is the only focus
 * signal persisted: WindowRegistry keeps focus *history*, not timestamps, so a
 * `lastFocusedAt` field would have nothing truthful to write into it.
 *
 * `projectId: null` is a real record, not a hole — a window sitting on the
 * project picker restores as a picker window.
 *
 * Deliberately dependency-free: the reader that consumes it runs before
 * `app.whenReady()`, and keeping the shape and its validation clear of the DB
 * and Electron lets the corruption matrix be unit-tested without either.
 * The write side lives in windowManifestStore.ts.
 */

export const OPEN_WINDOWS_KEY = "openWindows";
export const OPEN_WINDOWS_MANIFEST_VERSION = 1;

/**
 * Hard cap on restored windows. Two jobs: a corrupt or hand-edited manifest
 * can't launch an unbounded fleet, and a user who genuinely accumulated dozens
 * of windows doesn't get a relaunch that spawns dozens of renderers at once.
 * Applied AFTER focus ordering, so the windows dropped are the ones focused
 * longest ago.
 */
export const MAX_RESTORED_WINDOWS = 8;

export interface OpenWindowRecord {
  /** Stable project id, or null for a window on the project picker. */
  projectId: string | null;
}

export interface OpenWindowsManifest {
  version: number;
  windows: OpenWindowRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate a stored manifest. Pure — no IO, no DB — so the corruption
 * matrix is unit-testable.
 *
 * Every failure mode collapses to `[]`, which the caller reads as "nothing to
 * restore, open one window". Being wrong in that direction costs the user a
 * manual window; being wrong in the other direction opens windows they never
 * had.
 */
export function parseOpenWindowsManifest(raw: string | null | undefined): OpenWindowRecord[] {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];
  // A future version's shape is unknown, so it is not merely unsupported — it
  // is unreadable. Refuse it rather than guessing at fields.
  if (parsed.version !== OPEN_WINDOWS_MANIFEST_VERSION) return [];
  if (!Array.isArray(parsed.windows)) return [];

  const records: OpenWindowRecord[] = [];
  for (const entry of parsed.windows) {
    if (!isRecord(entry)) continue;
    const { projectId } = entry;
    // Anything that isn't a non-empty string or an explicit null is malformed.
    // Coercing it would invent a project id.
    if (projectId === null) {
      records.push({ projectId: null });
    } else if (typeof projectId === "string" && projectId.length > 0) {
      records.push({ projectId });
    }
    if (records.length >= MAX_RESTORED_WINDOWS) break;
  }

  return records;
}

export function serializeOpenWindowsManifest(records: OpenWindowRecord[]): string {
  const manifest: OpenWindowsManifest = {
    version: OPEN_WINDOWS_MANIFEST_VERSION,
    windows: records.slice(0, MAX_RESTORED_WINDOWS).map(({ projectId }) => ({ projectId })),
  };
  return JSON.stringify(manifest);
}

/**
 * Drop records whose project no longer exists, keeping picker windows.
 *
 * Skipping is deliberate and matches VS Code: a deleted project must never be
 * silently replaced by a different one, and it must not stop the surviving
 * windows from restoring.
 */
export function filterRestorableWindows(
  records: OpenWindowRecord[],
  existingProjectIds: ReadonlySet<string>
): OpenWindowRecord[] {
  return records.filter(
    (record) => record.projectId === null || existingProjectIds.has(record.projectId)
  );
}

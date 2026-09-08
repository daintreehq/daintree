/**
 * The open-window manifest: which project each window was showing when the app
 * last ran, so a relaunch can rebuild the whole set instead of one window
 * (#11492), plus which further projects that window had live so the relaunch
 * brings their agents back too rather than one project per window (#12320).
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

/**
 * Hard cap on background projects stored per window. Deliberately larger than
 * any machine's warm-view ceiling (5): the ceiling is a *runtime* budget that
 * moves with RAM tier and memory pressure, so truncating to it here would burn
 * the smaller number into the manifest and permanently lose projects the next
 * launch had room for. Restore-time admission applies the real ceiling; this
 * bound exists only so a corrupt or hand-edited manifest can't name thousands.
 */
export const MAX_BACKGROUND_PROJECTS_PER_WINDOW = 8;

export interface OpenWindowRecord {
  /**
   * Stable workspace id — a project id or a scratch id — or null for a window
   * on the project picker. The two kinds are disjoint id spaces, so one opaque
   * field carries both and the shape tells the reader which table to validate
   * it against (#11958). The wire key stays `projectId`: renaming it would make
   * every stored manifest unreadable for a purely cosmetic gain.
   */
  projectId: string | null;
  /**
   * Further workspaces this window had live — a warm background view, or a
   * project whose view was evicted while its agents kept running — ordered
   * most-recently-used first (#12320). Optional and additive: the field was
   * introduced without a version bump, so a manifest written before it reads
   * as a window with no background projects rather than as corruption. Never
   * contains `projectId`, and never a duplicate.
   */
  backgroundProjectIds?: string[];
}

export interface OpenWindowsManifest {
  version: number;
  windows: OpenWindowRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `raw` is a manifest this version can read — regardless of how many
 * windows survive entry validation.
 *
 * An empty window list is readable: it is a manifest, just one that named
 * nothing. What that means for the launch is the reader's call, not this
 * predicate's — `readOpenWindowsManifestSync` treats it as no manifest, because
 * closing the last window is the quit gesture on Windows and Linux and persists
 * exactly this shape.
 *
 * All-malformed entries deliberately read as unreadable rather than empty: that
 * is corrupt data, and keeping it distinguishable from an intentional shape is
 * what lets the corruption matrix be tested without a DB.
 */
export function isReadableOpenWindowsManifest(raw: string | null | undefined): boolean {
  if (!raw) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!isRecord(parsed)) return false;
  if (parsed.version !== OPEN_WINDOWS_MANIFEST_VERSION) return false;
  if (!Array.isArray(parsed.windows)) return false;

  // An empty list is readable. A non-empty list that yields no usable record is
  // corrupt.
  return parsed.windows.length === 0 || parseOpenWindowsManifest(raw).length > 0;
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
      records.push(withBackgroundProjectIds({ projectId: null }, entry.backgroundProjectIds));
    } else if (typeof projectId === "string" && projectId.length > 0) {
      records.push(withBackgroundProjectIds({ projectId }, entry.backgroundProjectIds));
    }
    if (records.length >= MAX_RESTORED_WINDOWS) break;
  }

  return records;
}

/**
 * Attach a validated background list to a record whose foreground already
 * parsed.
 *
 * A malformed background field costs only itself: the window still restores,
 * because losing the window is worse than losing which extra projects it had.
 * That asymmetry is why this never rejects the record it is given.
 */
function withBackgroundProjectIds(record: OpenWindowRecord, raw: unknown): OpenWindowRecord {
  const ids = parseBackgroundProjectIds(raw, record.projectId);
  return ids.length > 0 ? { ...record, backgroundProjectIds: ids } : record;
}

/**
 * Validate one window's background list: non-empty strings only, order
 * preserved (it is the recency signal), deduplicated, never the window's own
 * foreground workspace, capped.
 *
 * The foreground exclusion is enforced on read rather than trusted from the
 * writer: a window that restores its own project twice would create a second
 * view for a workspace the manager already has, and the duplicate would sit in
 * the cache doing nothing but occupying a slot a real project needed.
 */
function parseBackgroundProjectIds(raw: unknown, foregroundId: string | null): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (value === foregroundId) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
    if (ids.length >= MAX_BACKGROUND_PROJECTS_PER_WINDOW) break;
  }
  return ids;
}

/**
 * An empty background list is omitted rather than written as `[]`, so a fleet
 * with nothing to restore beyond its foreground projects serializes byte-for-byte
 * as it did before #12320 — which is what keeps the pre-existing shape tests
 * meaningful instead of merely updated.
 */
export function serializeOpenWindowsManifest(records: OpenWindowRecord[]): string {
  const manifest: OpenWindowsManifest = {
    version: OPEN_WINDOWS_MANIFEST_VERSION,
    windows: records.slice(0, MAX_RESTORED_WINDOWS).map(({ projectId, backgroundProjectIds }) => {
      const ids = parseBackgroundProjectIds(backgroundProjectIds, projectId);
      return ids.length > 0 ? { projectId, backgroundProjectIds: ids } : { projectId };
    }),
  };
  return JSON.stringify(manifest);
}

/**
 * Drop records whose workspace no longer exists, keeping picker windows.
 *
 * Skipping is deliberate and matches VS Code: a deleted project must never be
 * silently replaced by a different one, and it must not stop the surviving
 * windows from restoring.
 *
 * `existingWorkspaceIds` spans both kinds — live projects and live scratches.
 * A set built from `projects` alone reads every scratch as deleted (#11958).
 */
export function filterRestorableWindows(
  records: OpenWindowRecord[],
  existingWorkspaceIds: ReadonlySet<string>
): OpenWindowRecord[] {
  return records
    .filter((record) => record.projectId === null || existingWorkspaceIds.has(record.projectId))
    .map((record) => {
      // Background ids are filtered by the same rule and for the same reason,
      // one level down: a deleted project is skipped, never substituted. A
      // window whose whole background list was deleted still restores — it just
      // restores the one project it was showing, which is exactly today's
      // behaviour.
      if (!record.backgroundProjectIds) return record;
      const surviving = record.backgroundProjectIds.filter((id) => existingWorkspaceIds.has(id));
      if (surviving.length === record.backgroundProjectIds.length) return record;
      if (surviving.length === 0) {
        const { backgroundProjectIds: _dropped, ...rest } = record;
        return rest;
      }
      return { ...record, backgroundProjectIds: surviving };
    });
}

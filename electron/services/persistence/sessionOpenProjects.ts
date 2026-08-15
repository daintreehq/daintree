/**
 * The session-open checkpoint: which projects the user had open when the app
 * last ran, so the switcher's recently-active dot marks that set and nothing
 * else (#11794).
 *
 * Stored as a single JSON value under `app_state.sessionOpenProjects`, beside
 * the `currentProjectId` scalar and the `openWindows` manifest. That table is a
 * schemaless key/value store, so this needs no drizzle migration.
 *
 * Membership is user intent, not resource state: a project joins when it is
 * opened or switched to and leaves when it is closed, removed, or goes missing.
 * It is deliberately NOT derived from `status`, which is what #11794 was —
 * `background` is written on every "no longer current" transition and cleared
 * only by an explicit close, so it latches on for the life of the install.
 *
 * Order carries no meaning. Ids are serialized deduplicated and sorted so the
 * stored value is stable for a given set and nothing downstream can start
 * reading the array as a ranking.
 *
 * Uncapped, unlike the window manifest's MAX_RESTORED_WINDOWS: these ids spawn
 * nothing, and truncating them would silently under-report the set the dot is
 * supposed to describe. There is no truthful entry to drop either — the payload
 * has no timestamps to order by.
 *
 * Deliberately dependency-free: the reader that consumes it runs before
 * `app.whenReady()`, and keeping the shape and its validation clear of the DB
 * and Electron lets the corruption matrix be unit-tested without either.
 * The write side lives in sessionOpenProjectsStore.ts.
 */

export const SESSION_OPEN_PROJECTS_KEY = "sessionOpenProjects";
export const SESSION_OPEN_PROJECTS_VERSION = 1;

export interface SessionOpenProjectsCheckpoint {
  version: number;
  projectIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate a stored checkpoint. Pure — no IO, no DB — so the
 * corruption matrix is unit-testable.
 *
 * Every failure mode collapses to `[]`, which the caller reads as "the previous
 * session named nothing", i.e. no dots for one launch. Being wrong in that
 * direction costs a decoration; being wrong in the other marks projects the
 * user never had open, which is the bug this replaces.
 *
 * An empty list and a missing row are deliberately indistinguishable here: both
 * mean the same thing to every caller, unlike the window manifest where "named
 * zero windows" and "no manifest" drive different restore decisions.
 */
export function parseSessionOpenProjects(raw: string | null | undefined): string[] {
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
  if (parsed.version !== SESSION_OPEN_PROJECTS_VERSION) return [];
  if (!Array.isArray(parsed.projectIds)) return [];

  const ids = new Set<string>();
  for (const entry of parsed.projectIds) {
    // Anything that isn't a non-empty string is malformed. Coercing it would
    // invent a project id, and an invented id can collide with a real row.
    if (typeof entry === "string" && entry.length > 0) ids.add(entry);
  }

  return [...ids].sort();
}

export function serializeSessionOpenProjects(projectIds: Iterable<string>): string {
  const checkpoint: SessionOpenProjectsCheckpoint = {
    version: SESSION_OPEN_PROJECTS_VERSION,
    projectIds: [...new Set(projectIds)].filter((id) => id.length > 0).sort(),
  };
  return JSON.stringify(checkpoint);
}

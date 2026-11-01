import { eq } from "drizzle-orm";
import { isProjectListSortMode, type ProjectGroup } from "../../shared/types/project.js";
import { getSharedDb } from "./persistence/db.js";
import { appState as appStateTable } from "./persistence/schema.js";
import { logError } from "../utils/logger.js";

/**
 * User-made project groups, stored as one JSON document in `app_state`.
 *
 * A handful of named rows that only ever change by explicit user action, read
 * whole every time and written whole every time — so a document, not a table:
 * no migration to add a field, and a write is atomic by construction. The
 * membership side lives on the project row (`projects.group_id`), where the
 * project's own reads already are.
 */
const APP_STATE_KEY = "projectGroups";

const DOCUMENT_VERSION = 1;

export type ProjectGroupsWriter = Pick<ReturnType<typeof getSharedDb>, "insert">;

interface ProjectGroupsDocument {
  version: number;
  groups: ProjectGroup[];
}

function isProjectGroup(value: unknown): value is ProjectGroup {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Record<string, unknown>;
  return (
    typeof group.id === "string" &&
    group.id.length > 0 &&
    typeof group.name === "string" &&
    group.name.length > 0 &&
    typeof group.position === "number" &&
    Number.isFinite(group.position) &&
    isProjectListSortMode(group.sortMode) &&
    typeof group.createdAt === "number"
  );
}

/** Position, then creation time, then id — total, so two equal slots never flip. */
function sortGroups(groups: ProjectGroup[]): ProjectGroup[] {
  return [...groups].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
}

/** Rewrites positions to 0..n-1 in the given order, so they never drift apart. */
function renumber(groups: ProjectGroup[]): ProjectGroup[] {
  return groups.map((group, position) =>
    group.position === position ? group : { ...group, position }
  );
}

/**
 * Every valid group, in render order. Shared by {@link ProjectGroupStore} and
 * the project registry, which checks a creation dialog's group against it at
 * the moment a new row is written, so both read one definition of a group.
 */
export function readProjectGroups(): ProjectGroup[] {
  const row = getSharedDb()
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, APP_STATE_KEY))
    .get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as Partial<ProjectGroupsDocument>;
    if (!Array.isArray(parsed.groups)) return [];
    // A malformed entry is dropped rather than failing the whole list: one
    // bad row must not take every other group's header with it. A repeated
    // id keeps its first entry, or no reorder could ever name each group
    // once, and a rename would rename both.
    const seen = new Set<string>();
    const valid = parsed.groups.filter(isProjectGroup).filter((group) => {
      if (seen.has(group.id)) return false;
      seen.add(group.id);
      return true;
    });
    return renumber(sortGroups(valid));
  } catch (error) {
    logError("Failed to read project groups", error);
    return [];
  }
}

/** Writes through `writer` so a caller inside a transaction can pass its own. */
export function writeProjectGroups(
  groups: ProjectGroup[],
  writer: ProjectGroupsWriter = getSharedDb()
): ProjectGroup[] {
  const ordered = renumber(sortGroups(groups));
  const value = JSON.stringify({
    version: DOCUMENT_VERSION,
    groups: ordered,
  } satisfies ProjectGroupsDocument);
  writer
    .insert(appStateTable)
    .values({ key: APP_STATE_KEY, value })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
    .run();
  return ordered;
}

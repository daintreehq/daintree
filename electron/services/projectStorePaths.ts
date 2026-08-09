import { createHash, randomBytes } from "crypto";
import path from "path";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";

export const UTF8_BOM = "\uFEFF";

const SETTINGS_FILENAME = "settings.json";
const RECIPES_FILENAME = "recipes.json";
const COPY_TREE_HISTORY_FILENAME = "copy-tree-history.json";

const STATE_FILENAME = "state.json";

/**
 * Legacy path-derived project id. Still the *minting* rule for a brand-new
 * project (see {@link mintProjectId}), but it is no longer an identity oracle:
 * once a project is registered its id is immutable, so a project that has moved
 * has an id that no longer matches `generateProjectId(project.path)`. Never call
 * this to *look up* an existing project \u2014 resolve by path through the DB
 * instead, or the lookup silently misses every relocated project (#11282).
 */
export function generateProjectId(projectPath: string): string {
  return createHash("sha256").update(projectPath.normalize("NFC")).digest("hex");
}

/**
 * Picks the id for a newly registered project at `normalizedPath`.
 *
 * Normally this is `generateProjectId(normalizedPath)`, which keeps ids stable
 * and debuggable. But because ids now survive a folder move, the hash of a path
 * is no longer guaranteed free: a project that moved away from `/foo` keeps
 * `sha256("/foo")` forever, so a *different* repository later created at `/foo`
 * would collide with its primary key. `isTaken` lets the caller consult the
 * project table; on collision we fall back to random bytes.
 *
 * The fallback keeps the 64-lowercase-hex shape that {@link isValidProjectId}
 * and {@link getProjectStateDir} depend on, so no state-directory or path-safety
 * assumption changes.
 */
export function mintProjectId(normalizedPath: string, isTaken: (id: string) => boolean): string {
  const preferred = generateProjectId(normalizedPath);
  if (!isTaken(preferred)) return preferred;

  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomBytes(32).toString("hex");
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error("Failed to mint a unique project id");
}

export function isValidProjectId(projectId: string): boolean {
  return isProjectWorkspaceId(projectId);
}

/**
 * Shape of a scratch id. The patterns themselves live in `shared/` because the
 * renderer has to route on them too — `pilot.openRun` picks between the project
 * and scratch switch handlers — and this module cannot be imported there (it
 * pulls in node `crypto`). `isValidScratchId` delegates here, keeping one
 * source of truth for the shape.
 */
export function isValidScratchStateId(id: string): boolean {
  return isScratchWorkspaceId(id);
}

/**
 * Ids allowed to own a directory under `userData/projects/`. Scratches have no
 * Project row but still need durable panel state (#11484), and a scratch UUID
 * (36 chars, dashed) can never collide with a project id (64 hex, undashed), so
 * both kinds share one state-directory namespace and all of the atomic-write /
 * quarantine / recovery machinery built on it.
 *
 * Deliberately distinct from {@link isValidProjectId}, which still means "a
 * project id" for the git-tracked `.daintree/project.json` anchor.
 */
export function isValidWorkspaceStateId(id: string): boolean {
  return isValidProjectId(id) || isValidScratchStateId(id);
}

export function getProjectStateDir(projectsConfigDir: string, projectId: string): string | null {
  if (!isValidWorkspaceStateId(projectId)) {
    return null;
  }
  const normalizedRoot = path.normalize(projectsConfigDir);
  const stateDir = path.join(normalizedRoot, projectId);
  const normalized = path.normalize(stateDir);
  if (!normalized.startsWith(normalizedRoot + path.sep)) {
    return null;
  }
  return normalized;
}

export function stateFilePath(projectsConfigDir: string, projectId: string): string | null {
  const stateDir = getProjectStateDir(projectsConfigDir, projectId);
  if (!stateDir) return null;
  return path.join(stateDir, STATE_FILENAME);
}

export function settingsFilePath(projectsConfigDir: string, projectId: string): string | null {
  const stateDir = getProjectStateDir(projectsConfigDir, projectId);
  if (!stateDir) return null;
  return path.join(stateDir, SETTINGS_FILENAME);
}

export function recipesFilePath(projectsConfigDir: string, projectId: string): string | null {
  const stateDir = getProjectStateDir(projectsConfigDir, projectId);
  if (!stateDir) return null;
  return path.join(stateDir, RECIPES_FILENAME);
}

export function copyTreeHistoryFilePath(
  projectsConfigDir: string,
  projectId: string
): string | null {
  const stateDir = getProjectStateDir(projectsConfigDir, projectId);
  if (!stateDir) return null;
  return path.join(stateDir, COPY_TREE_HISTORY_FILENAME);
}

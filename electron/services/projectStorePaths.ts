import { createHash, randomBytes } from "crypto";
import path from "path";

export const UTF8_BOM = "\uFEFF";

const SETTINGS_FILENAME = "settings.json";
const RECIPES_FILENAME = "recipes.json";

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
  return /^[0-9a-f]{64}$/.test(projectId);
}

export function getProjectStateDir(projectsConfigDir: string, projectId: string): string | null {
  if (!isValidProjectId(projectId)) {
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

import { createHash } from "crypto";
import path from "path";

export const UTF8_BOM = "\uFEFF";

const SETTINGS_FILENAME = "settings.json";
const RECIPES_FILENAME = "recipes.json";
const WORKFLOWS_FILENAME = "workflows.json";
const STATE_FILENAME = "state.json";

export function generateProjectId(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex");
}

export function isValidProjectId(projectId: string): boolean {
  return /^[0-9a-f]{64}$/.test(projectId);
}

export function getProjectStateDir(projectsConfigDir: string, projectId: string): string | null {
  if (!isValidProjectId(projectId)) {
    return null;
  }
  const stateDir = path.join(projectsConfigDir, projectId);
  const normalized = path.normalize(stateDir);
  if (!normalized.startsWith(projectsConfigDir + path.sep)) {
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

export function workflowsFilePath(projectsConfigDir: string, projectId: string): string | null {
  const stateDir = getProjectStateDir(projectsConfigDir, projectId);
  if (!stateDir) return null;
  return path.join(stateDir, WORKFLOWS_FILENAME);
}

import { store } from "../store.js";
import { projectStore } from "../services/ProjectStore.js";
import {
  DEFAULT_WORKTREE_PATH_PATTERN,
  validatePathPattern,
} from "../../shared/utils/pathPattern.js";

export async function resolveWorktreePattern(rootPath: string): Promise<string> {
  const project = await projectStore.getProjectByPath(rootPath);
  if (project) {
    const settings = await projectStore.getProjectSettings(project.id);
    if (settings?.worktreePathPattern) {
      const validation = validatePathPattern(settings.worktreePathPattern);
      if (validation.valid) {
        return settings.worktreePathPattern;
      }
    }
  }
  const configPattern = store.get("worktreeConfig.pathPattern");
  return typeof configPattern === "string" && configPattern.trim()
    ? configPattern
    : DEFAULT_WORKTREE_PATH_PATTERN;
}

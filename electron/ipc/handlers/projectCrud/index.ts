/**
 * Project CRUD handlers — composes all project-related IPC handlers.
 *
 * Split from the monolithic projectCrud.ts into focused modules:
 * - crud.ts:     get, add, update, remove, open-dialog, close, check-missing, locate
 * - switch.ts:   switch, reopen (multi-view orchestration + ProjectSwitchService fallback)
 * - settings.ts: get/save settings, detect-runners, create-folder
 * - stats.ts:    getProjectStatsService() + stats/bulk-stats handlers
 * - gitInit.ts:  init, init-guided (with gitignore templates)
 * - gitClone.ts: clone-repo, clone-cancel (AbortController state)
 */

import type { HandlerDependencies } from "../../types.js";
import { registerProjectCrudCoreHandlers } from "./crud.js";
import { registerProjectSwitchHandlers } from "./switch.js";
import { registerProjectSettingsHandlers } from "./settings.js";
import { registerProjectStatsHandlers } from "./stats.js";
import { registerGitInitHandlers } from "./gitInit.js";
import { registerGitCloneHandlers } from "./gitClone.js";

export { getProjectStatsService } from "./stats.js";

export function registerProjectCrudHandlers(deps: HandlerDependencies): () => void {
  const cleanups = [
    registerProjectStatsHandlers(deps),
    registerProjectCrudCoreHandlers(deps),
    registerProjectSwitchHandlers(deps),
    registerProjectSettingsHandlers(),
    registerGitInitHandlers(),
    registerGitCloneHandlers(),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}

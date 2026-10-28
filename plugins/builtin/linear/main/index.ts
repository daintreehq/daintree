import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { clearLinearCaches, linearForgeProvider, setTeamKeyReader } from "./forgeProvider.js";
import { setMemoryToken } from "./LinearClient.js";

const PLUGIN_ID = "daintree.linear";
const TEAM_KEY_SETTING = "teamKey";

/**
 * Read the project-scoped `teamKey` for one project. `host.settings.get`
 * resolves project scope against whichever project is active, but the host
 * asks for a specific project's issues — a background project's list must not
 * come back filtered by the focused project's team. So the project the host
 * named is looked up by path and read through the same id-targeted settings
 * path the Project settings form uses. Both services load lazily: this module
 * is loaded by `PluginService` itself.
 */
async function readTeamKey(projectPath: string): Promise<string | undefined> {
  const [{ projectStore }, { pluginService }] = await Promise.all([
    import("../../../../electron/services/ProjectStore.js"),
    import("../../../../electron/services/PluginService.js"),
  ]);
  const project = await projectStore.getProjectByPath(projectPath);
  if (!project) return undefined;
  const { values } = await pluginService.getSettingValuesForUi(PLUGIN_ID, "project", project.id);
  const value = values[TEAM_KEY_SETTING];
  return typeof value === "string" ? value : undefined;
}

/**
 * Plugin activation entry point. Registers the issues-only `linear` provider.
 * The API key lives in the host's `forgeCredentials` store and is replayed into
 * `setCredentials` during registration; the team a project's issues come from
 * is its `teamKey` project setting.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  setTeamKeyReader(readTeamKey);
  const disposeForge = await host.registerForgeProvider({ id: "linear" }, linearForgeProvider);
  return () => {
    disposeForge();
    setTeamKeyReader(null);
    // Re-enable replays the durable credential via setCredentials.
    setMemoryToken(null);
    clearLinearCaches();
  };
}

export { linearForgeProvider, normalizeTeamKey } from "./forgeProvider.js";

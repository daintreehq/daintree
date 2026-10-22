import path from "node:path";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { clearLinearCaches, linearForgeProvider, setTeamKeyReader } from "./forgeProvider.js";
import { setMemoryToken } from "./LinearClient.js";

const PLUGIN_ID = "daintree.linear";
const TEAM_KEY_SETTING = "teamKey";

/**
 * Read the project-scoped `teamKey` for one project. `host.settings.get`
 * resolves project scope against whichever project is active, but the host
 * asks for a specific project's issues — a background project's list must not
 * come back filtered by the focused project's team. So this reads the same
 * file the settings form writes, `<projectRoot>/.daintree/plugin-settings/`,
 * for the project the host named.
 */
async function readTeamKey(projectPath: string): Promise<string | undefined> {
  const { PluginSettingsStore } = await import("../../../../electron/services/PluginSettingsStore.js");
  const filePath = path.join(projectPath, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
  const value = await new PluginSettingsStore(filePath).get<unknown>(TEAM_KEY_SETTING);
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
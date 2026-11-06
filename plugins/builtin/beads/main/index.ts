import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { setMemoryToken } from "./BeadsClient.js";
import {
  beadsForgeProvider,
  clearBeadsCaches,
  setServerUrlSettingReader,
} from "./forgeProvider.js";

const PLUGIN_ID = "daintree.beads";
const SERVER_URL_SETTING = "serverUrl";

/**
 * Read the project-scoped `serverUrl` for one project. `host.settings.get`
 * resolves project scope against whichever project is active, but the host
 * asks for a specific project's issues, so the project it named is looked up
 * by path and read through the id-targeted path the Project settings form
 * uses. Both services load lazily: this module is loaded by `PluginService`.
 */
async function readServerUrlSetting(projectPath: string): Promise<string | undefined> {
  const [{ projectStore }, { pluginService }] = await Promise.all([
    import("../../../../electron/services/ProjectStore.js"),
    import("../../../../electron/services/PluginService.js"),
  ]);
  const project = await projectStore.getProjectByPath(projectPath);
  if (!project) return undefined;
  const { values } = await pluginService.getSettingValuesForUi(PLUGIN_ID, "project", project.id);
  const value = values[SERVER_URL_SETTING];
  return typeof value === "string" ? value : undefined;
}

/**
 * Plugin activation entry point. Registers the issues-only `beads` provider.
 * The token lives in the host's `forgeCredentials` store and is replayed into
 * `setCredentials` during registration; the server a project's beads come
 * from is its `serverUrl` setting, or the address `bd connect` recorded.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  setServerUrlSettingReader(readServerUrlSetting);
  let disposeForge: () => void;
  try {
    disposeForge = await host.registerForgeProvider({ id: "beads" }, beadsForgeProvider);
  } catch (err) {
    setServerUrlSettingReader(null);
    throw err;
  }
  return () => {
    disposeForge();
    setServerUrlSettingReader(null);
    // Re-enable replays the durable credential via setCredentials.
    setMemoryToken(null);
    clearBeadsCaches();
  };
}

export { beadsForgeProvider } from "./forgeProvider.js";

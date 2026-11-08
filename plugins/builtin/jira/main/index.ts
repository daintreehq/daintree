import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import {
  EMAIL_SETTING,
  JIRA_PLUGIN_ID,
  PROJECT_KEY_SETTING,
  SITE_URL_SETTING,
} from "../shared/connection.js";
import {
  clearJiraCaches,
  jiraForgeProvider,
  setConnectionSettingsReader,
  setProjectKeyReader,
} from "./forgeProvider.js";
import { setMemoryToken } from "./JiraClient.js";

/**
 * Read the project-scoped `projectKey` for one project. `host.settings.get`
 * resolves project scope against whichever project is active, but the host asks
 * for a specific project's issues, and a background project's list must not come
 * back from the focused project's Jira project. So the project the host named is
 * looked up by path and read through the same id-targeted settings path the
 * Project settings form uses. Both services load lazily: this module is loaded by
 * `PluginService` itself.
 */
async function readProjectKey(projectPath: string): Promise<string | undefined> {
  const [{ projectStore }, { pluginService }] = await Promise.all([
    import("../../../../electron/services/ProjectStore.js"),
    import("../../../../electron/services/PluginService.js"),
  ]);
  const project = await projectStore.getProjectByPath(projectPath);
  if (!project) return undefined;
  const { values } = await pluginService.getSettingValuesForUi(
    JIRA_PLUGIN_ID,
    "project",
    project.id
  );
  const value = values[PROJECT_KEY_SETTING];
  return typeof value === "string" ? value : undefined;
}

/**
 * Plugin activation entry point. Registers the issues-only `jira` provider. The
 * API token lives in the host's `forgeCredentials` store and is replayed into
 * `setCredentials` during registration; the site and email it authenticates with
 * are the plugin's user settings, and the Jira project a project's issues come
 * from is its `projectKey` project setting.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  setConnectionSettingsReader(async () => {
    const [siteUrl, email] = await Promise.all([
      host.settings.get<string>(SITE_URL_SETTING),
      host.settings.get<string>(EMAIL_SETTING),
    ]);
    return { siteUrl, email };
  });
  setProjectKeyReader(readProjectKey);
  const disposeForge = await host.registerForgeProvider({ id: "jira" }, jiraForgeProvider);
  return () => {
    disposeForge();
    setConnectionSettingsReader(null);
    setProjectKeyReader(null);
    // Re-enable replays the durable credential via setCredentials.
    setMemoryToken(null);
    clearJiraCaches();
  };
}

export { jiraForgeProvider, normalizeProjectKey } from "./forgeProvider.js";

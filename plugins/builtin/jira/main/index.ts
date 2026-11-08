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
 * The workspace hosts ask for a project's branch keys when it loads and when its
 * forge settings change, and a plugin setting is neither, so a key entered after
 * binding the provider would claim nothing until the next reload.
 */
async function refreshBranchClaims(): Promise<void> {
  try {
    const { getWorkspaceClient } = await import("../../../../electron/services/WorkspaceClient.js");
    await getWorkspaceClient().updateForgeSettingsForAllProjects();
  } catch {
    // WorkspaceClient may not be initialized yet; hosts read the keys when they load.
  }
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
  const disposeSettings = await Promise.all(
    [PROJECT_KEY_SETTING, SITE_URL_SETTING].map((key) =>
      host.settings.onDidChange(key, () => void refreshBranchClaims()).catch(() => () => undefined)
    )
  );
  const disposeForge = await host.registerForgeProvider({ id: "jira" }, jiraForgeProvider);
  return () => {
    disposeForge();
    for (const dispose of disposeSettings) dispose();
    setConnectionSettingsReader(null);
    setProjectKeyReader(null);
    // Re-enable replays the durable credential via setCredentials.
    setMemoryToken(null);
    clearJiraCaches();
  };
}

export { jiraForgeProvider, normalizeProjectKey } from "./forgeProvider.js";

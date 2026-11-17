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
import { setMemoryToken, setProvenanceAccessors, type CredentialProvenance } from "./JiraAuth.js";

/**
 * Plugin-storage key of the stored token's {@link CredentialProvenance}: where it
 * was proven to belong, and a digest of it, never the token.
 */
const CREDENTIAL_PROVENANCE_KEY = "credentialProvenance";

function isProvenance(value: unknown): value is CredentialProvenance {
  if (!value || typeof value !== "object") return false;
  const { binding, tokenDigest } = value as Record<string, unknown>;
  return typeof binding === "string" && binding !== "" && typeof tokenDigest === "string";
}

/**
 * Wires the token's durable provenance. Loaded before registration, because the
 * host replays the stored token into `setCredentials` as part of it, and a token
 * read before its record would have nowhere it may go.
 */
async function wireProvenance(host: PluginHostApi): Promise<void> {
  let provenance: CredentialProvenance | null | "unreadable";
  try {
    const stored = await host.storage.get<unknown>(CREDENTIAL_PROVENANCE_KEY);
    provenance =
      stored === undefined || stored === null ? null : isProvenance(stored) ? stored : "unreadable";
  } catch {
    // Withholds the token rather than guessing where it belongs.
    provenance = "unreadable";
  }
  setProvenanceAccessors(
    () => provenance,
    (record) => {
      provenance = record;
      void (
        record === null
          ? host.storage.delete(CREDENTIAL_PROVENANCE_KEY)
          : host.storage.set(CREDENTIAL_PROVENANCE_KEY, record)
      ).catch(() => undefined);
    }
  );
}

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
 * are the plugin's user settings, where it may go is the plugin's own storage,
 * and the Jira project a project's issues come from is its `projectKey` project
 * setting.
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
  await wireProvenance(host);
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
    // Detached first: clearing the token with the writer still wired would
    // delete the record, and re-enabling would then find nowhere it may go.
    setProvenanceAccessors(null, null);
    // Re-enable replays the durable credential via setCredentials.
    setMemoryToken(null);
    clearJiraCaches();
  };
}

export { jiraForgeProvider, normalizeProjectKey } from "./forgeProvider.js";

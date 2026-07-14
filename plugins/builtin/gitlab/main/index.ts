import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { BUILTIN_GITLAB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";
import {
  getToken,
  getTokenVersion,
  markTokenHealthy,
  markTokenUnhealthy,
  setInstanceUrlReader,
  setMemoryToken,
  setValidatedUserInfo,
  validateGitLabToken,
} from "./GitLabAuth.js";
import { gitlabForgeProvider } from "./forgeProvider.js";
import { clearGitLabCaches } from "./readOps.js";

/**
 * Float a one-shot validation of the stored token so user info (username,
 * avatar, scopes) is cached for the session and token health reflects
 * reality. Never awaited — validation has an internal timeout and the
 * tokenVersion guard makes both the cache write and the health stamp no-ops
 * if the token rotates (or the plugin deactivates and clears it) mid-flight.
 */
function validateStoredTokenInBackground(): void {
  const token = getToken();
  if (!token) return;
  const versionAtStart = getTokenVersion();
  void (async () => {
    try {
      const validation = await validateGitLabToken(token);
      if (validation.valid && validation.username) {
        setValidatedUserInfo(
          {
            username: validation.username,
            ...(validation.avatarUrl ? { avatarUrl: validation.avatarUrl } : {}),
            ...(validation.scopes ? { scopes: validation.scopes } : {}),
          },
          versionAtStart
        );
        console.log("[gitlab-plugin] user info cached for:", validation.username);
      }
      // Health flows straight from this validation — a second probe via
      // refreshTokenHealth would double-hit /user and, worse, could run
      // after deactivation against the fallback instance URL.
      if (validation.valid) {
        markTokenHealthy(versionAtStart);
      } else if (validation.credentialRejected) {
        markTokenUnhealthy(versionAtStart);
      }
    } catch (err) {
      console.warn("[gitlab-plugin] Failed to validate stored GitLab token:", err);
    }
  })();
}

/**
 * Push the current credentials to every running workspace host. Covers hosts
 * that became ready before this plugin activated — the host-side ready replay
 * pulls from the forge registry, which only knows this provider after
 * activate() binds it.
 */
async function syncCredentialsToWorkspaceHosts(): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    const { getWorkspaceClient } = await import("../../../../electron/services/WorkspaceClient.js");
    getWorkspaceClient().updateForgeCredentials(BUILTIN_GITLAB_PROVIDER_ID, {
      kind: "bearer",
      value: token,
    });
  } catch {
    // WorkspaceClient may not be initialized yet — hosts created later are
    // seeded from the registry-backed ready replay.
  }
}

/**
 * Plugin activation entry point — called by `PluginService` after manifest
 * validation. Registers the `gitlab` forge provider declared in
 * `plugin.json`. The durable token lives in the host's `forgeCredentials`
 * store and is replayed into `setCredentials` during registration; the
 * instance URL is the plugin's `instanceUrl` setting, read through the
 * accessor wired here so auth-path requests always see the current value.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  setInstanceUrlReader(() => host.settings.get<string>("instanceUrl"));
  const disposeForge = await host.registerForgeProvider({ id: "gitlab" }, gitlabForgeProvider);
  validateStoredTokenInBackground();
  void syncCredentialsToWorkspaceHosts();
  return () => {
    disposeForge();
    // Clear the in-memory token BEFORE removing the settings reader: any
    // still-floating request that resolves after this point must find no
    // credential rather than a token paired with the default-instance
    // fallback. Re-enable replays the durable credential via setCredentials.
    setMemoryToken(null);
    setInstanceUrlReader(null);
    // Drop cached tooltip/stats/avatar pages so a later re-enable (possibly
    // under a different token or instance) starts from the network.
    clearGitLabCaches();
  };
}

export { gitlabForgeProvider } from "./forgeProvider.js";
export {
  getInstanceUrl,
  getInstanceHost,
  setInstanceUrlReader,
  validateGitLabToken,
  GITLAB_API_TIMEOUT_MS,
  GITLAB_AUTH_TIMEOUT_MS,
} from "./GitLabAuth.js";
export { parseGitLabRemoteUrl, repoFullPath, encodeProjectId } from "./gitlabRemote.js";
export { clearGitLabCaches } from "./readOps.js";

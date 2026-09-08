import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { BUILTIN_GITLAB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";
import {
  getInstanceUrl,
  getToken,
  currentIdentityGeneration,
  getTokenVersion,
  markTokenHealthy,
  markTokenUnhealthy,
  setInstanceUrlReader,
  setMemoryToken,
  setProvenanceAccessors,
  setValidatedUserInfo,
  clearValidatedUserInfo,
  validateStoredGitLabToken,
  type CredentialProvenance,
} from "./GitLabAuth.js";
import { gitlabForgeProvider } from "./forgeProvider.js";

/**
 * Plugin-storage key holding {@link CredentialProvenance}. Storage is
 * plaintext JSON, so this records only the instance and a token DIGEST —
 * never the credential.
 */
const CREDENTIAL_PROVENANCE_KEY = "credentialProvenance";
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
  const identityAtStart = currentIdentityGeneration();
  void (async () => {
    try {
      const validation = await validateStoredGitLabToken(token);
      if (validation.valid && validation.username) {
        setValidatedUserInfo(
          {
            username: validation.username,
            ...(validation.avatarUrl ? { avatarUrl: validation.avatarUrl } : {}),
            ...(validation.scopes ? { scopes: validation.scopes } : {}),
          },
          versionAtStart,
          identityAtStart
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
  // Prime the synchronous instance cache before the provider is reachable.
  // The contract's URL builders and `parseRemote` are synchronous, so on a
  // self-hosted install they'd otherwise emit `https://<host>/…` — dropping a
  // custom port and deployment path — until some other call happened to read
  // the setting first.
  await getInstanceUrl().catch(() => undefined);

  // Load the credential's durable provenance BEFORE registration, because the
  // host replays the stored credential into `setCredentials` as part of it.
  // Without the record loaded, the replayed token would take its instance from
  // whatever `instanceUrl` currently says — which is how a token saved for one
  // instance ends up authenticating against another.
  let provenance: CredentialProvenance | null = null;
  try {
    provenance = (await host.storage.get<CredentialProvenance>(CREDENTIAL_PROVENANCE_KEY)) ?? null;
  } catch {
    // Unreadable storage leaves the provenance unknown, which withholds the
    // token rather than guessing where it belongs.
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

  // Keep the instance cache honest. It backs the synchronous URL builders and
  // the remote parser, so a stale base after an instance change would strip a
  // namespace segment that is no longer a deployment prefix, or build links
  // against the old origin. Subscribing must happen during activate().
  const disposeSettings = await host.settings
    .onDidChange<string>("instanceUrl", () => {
      void getInstanceUrl()
        .catch(() => undefined)
        // Everything cached — tooltips, stats, avatars, the validated identity
        // — was fetched from the previous instance and describes projects that
        // may not even exist on the new one.
        .finally(() => {
          clearGitLabCaches();
          clearValidatedUserInfo();
        });
    })
    .catch(() => () => undefined);
  const disposeForge = await host.registerForgeProvider({ id: "gitlab" }, gitlabForgeProvider);
  validateStoredTokenInBackground();
  void syncCredentialsToWorkspaceHosts();
  return () => {
    disposeSettings();
    setProvenanceAccessors(null, null);
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
export { getInstanceUrl };
export {
  getInstanceHost,
  setInstanceUrlReader,
  validateGitLabToken,
  GITLAB_API_TIMEOUT_MS,
  GITLAB_AUTH_TIMEOUT_MS,
} from "./GitLabAuth.js";
export { parseGitLabRemoteUrl, repoFullPath, encodeProjectId } from "./gitlabRemote.js";
export { clearGitLabCaches } from "./readOps.js";

import type { GitHubTokenValidation } from "./GitHubAuth.js";
import { GitHubAuth } from "./GitHubAuth.js";
import { setGitHubToken, clearGitHubToken, validateGitHubToken } from "./GitHubToken.js";
import { gitHubTokenHealthService } from "./GitHubTokenHealthService.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";

async function syncWorkspaceToken(token: string | null): Promise<void> {
  try {
    const { getWorkspaceClient } = await import("../../../../electron/services/WorkspaceClient.js");
    const credentials = token ? { kind: "bearer" as const, value: token } : null;
    getWorkspaceClient().updateForgeCredentials(BUILTIN_GITHUB_PROVIDER_ID, credentials);
  } catch {
    // WorkspaceClient may not be initialized yet
  }
}

export async function setTokenAndSync(token: string): Promise<GitHubTokenValidation> {
  const trimmed = token.trim();
  const validation = await validateGitHubToken(trimmed);

  if (validation.valid) {
    setGitHubToken(trimmed);
    const versionAfterSet = GitHubAuth.getTokenVersion();

    if (validation.username) {
      GitHubAuth.setValidatedUserInfo(
        validation.username,
        validation.avatarUrl,
        validation.scopes,
        versionAfterSet
      );
    }

    await syncWorkspaceToken(trimmed);

    gitHubTokenHealthService.resetState();
    void gitHubTokenHealthService.refresh({ force: true }).catch(() => {});
  }

  return validation;
}

export async function clearTokenAndSync(): Promise<void> {
  clearGitHubToken();
  await syncWorkspaceToken(null);
  gitHubTokenHealthService.resetState();
}

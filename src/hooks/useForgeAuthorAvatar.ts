import { useEffect, useState } from "react";
import { BUILTIN_GITHUB_PROVIDER_ID, normalizeProviderId } from "@shared/utils/forgeProviderIds";
import { useGitHubPluginEnabled } from "@/store/pluginRuntimeStore";

/**
 * Resolve a commit author's forge avatar URL for the committer chip (#8514).
 *
 * Routes `email` to the forge identified by `linkedProviderId`, asks the
 * main-process provider to resolve it, and returns the URL — or `undefined`
 * while loading, on failure, or when no profile matches. `undefined` (not
 * `null`) is the loading/empty signal so it slots straight into the chip's
 * `forgeAvatarUrl?: string` prop and lets the existing Gravatar tier take over
 * with no extra branching at the call site.
 *
 * Network resolution, caching, and rate-limit handling all live behind the
 * IPC boundary in the provider — the hook never blocks render and never sees
 * backoff state.
 */
export function useForgeAuthorAvatar({
  email,
  linkedProviderId,
}: {
  email: string | undefined;
  linkedProviderId: string | undefined;
}): string | undefined {
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const githubEnabled = useGitHubPluginEnabled();

  useEffect(() => {
    setAvatarUrl(undefined);

    const trimmedEmail = email?.trim();
    if (!trimmedEmail) return;

    // Only GitHub has a provider today. A worktree linked to a different
    // forge falls straight through to Gravatar until that provider ships —
    // adding one is a new registry entry, no change here. Same Gravatar
    // fall-through while the GitHub plugin is disabled — the gated IPC
    // would only reject.
    if (!githubEnabled) return;
    if (normalizeProviderId(linkedProviderId) !== BUILTIN_GITHUB_PROVIDER_ID) return;

    let cancelled = false;
    window.electron.github
      .resolveAuthorAvatar(trimmedEmail)
      .then((url) => {
        if (!cancelled) setAvatarUrl(url ?? undefined);
      })
      .catch(() => {
        // Provider failures fall through to the next avatar tier silently.
      });

    return () => {
      cancelled = true;
    };
  }, [email, linkedProviderId, githubEnabled]);

  return avatarUrl;
}

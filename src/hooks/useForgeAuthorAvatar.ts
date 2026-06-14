import { useEffect, useState } from "react";
import { forgeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";

/**
 * Resolve a commit author's forge avatar URL for the committer chip (#8514).
 *
 * Routes `email` through the forge provider resolved for `cwd` (the worktree
 * path), asks the main-process provider to resolve it, and returns the URL —
 * or `undefined` while loading, on failure, or when no profile matches.
 * `undefined` (not `null`) is the loading/empty signal so it slots straight
 * into the chip's `forgeAvatarUrl?: string` prop and lets the existing
 * Gravatar tier take over with no extra branching at the call site.
 *
 * Gated on the project's resolved forge provider: while no provider resolves
 * (none registered, or the owning plugin is disabled) the hook falls straight
 * through to Gravatar without issuing IPC. Network resolution, caching, and
 * rate-limit handling all live behind the IPC boundary in the provider — the
 * hook never blocks render and never sees backoff state.
 */
export function useForgeAuthorAvatar({
  email,
  cwd,
}: {
  email: string | undefined;
  cwd: string | undefined;
}): string | undefined {
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { entry } = useResolvedForgeProvider(projectId);
  const providerResolved = entry !== null;

  useEffect(() => {
    setAvatarUrl(undefined);

    const trimmedEmail = email?.trim();
    if (!trimmedEmail || !cwd || !providerResolved) return;

    let cancelled = false;
    forgeClient
      .resolveAuthorAvatar(cwd, trimmedEmail)
      .then((url) => {
        if (!cancelled) setAvatarUrl(url ?? undefined);
      })
      .catch(() => {
        // Provider failures fall through to the next avatar tier silently.
      });

    return () => {
      cancelled = true;
    };
  }, [email, cwd, providerResolved]);

  return avatarUrl;
}

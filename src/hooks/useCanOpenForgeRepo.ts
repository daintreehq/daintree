import { useEffect, useState } from "react";
import { forgeClient } from "@/clients/forgeClient";

interface RepoLinkAnswer {
  projectPath: string;
  providerId: string;
  supported: boolean;
}

/**
 * Whether the project's forge provider can link to its repository page.
 * `buildRepoUrl` is an optional provider capability that only the main process
 * can see — the provider's manifest says nothing about it — so this asks once
 * per project and provider. Keyed on both, so switching either never shows the
 * previous answer while the new one is in flight.
 */
export function useCanOpenForgeRepo(
  projectPath: string | null | undefined,
  providerId: string | null
): boolean {
  const [answer, setAnswer] = useState<RepoLinkAnswer | null>(null);

  useEffect(() => {
    if (!projectPath || !providerId) return;
    let cancelled = false;
    void (async () => {
      let supported = false;
      try {
        supported = (await forgeClient.getRepoUrl(projectPath)) !== null;
      } catch {
        // A repository the provider can't resolve has no page to offer.
      }
      if (!cancelled) setAnswer({ projectPath, providerId, supported });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, providerId]);

  return (
    answer !== null &&
    answer.supported &&
    answer.projectPath === projectPath &&
    answer.providerId === providerId
  );
}

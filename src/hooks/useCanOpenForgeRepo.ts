import { useCallback, useEffect, useState } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { logDebug } from "@/utils/logger";

interface RepoLinkAnswer {
  projectPath: string;
  providerId: string;
  supported: boolean;
}

export interface ForgeRepoLink {
  canOpenRepo: boolean;
  /** Ask again, leaving the last answer standing until the new one lands. */
  recheck: () => void;
}

/**
 * Whether the project's forge provider can link to its repository page.
 * `buildRepoUrl` is an optional provider capability that only the main process
 * can see — the provider's manifest says nothing about it — so this asks main.
 *
 * The answer is keyed on project and provider, so switching either never shows
 * the previous one while the new one is in flight. A failed lookup is never
 * cached as "unsupported": it leaves the last answer standing, and `recheck` is
 * how a fix that changes neither key — a repaired remote, a lifted rate limit —
 * gets picked up.
 */
export function useCanOpenForgeRepo(
  projectPath: string | null | undefined,
  providerId: string | null
): ForgeRepoLink {
  const [answer, setAnswer] = useState<RepoLinkAnswer | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!projectPath || !providerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = await forgeClient.getRepoUrl(projectPath);
        if (!cancelled) setAnswer({ projectPath, providerId, supported: url !== null });
      } catch (error) {
        logDebug("Forge repository link lookup failed", { error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, providerId, generation]);

  const recheck = useCallback(() => setGeneration((n) => n + 1), []);

  return {
    canOpenRepo:
      answer !== null &&
      answer.supported &&
      answer.projectPath === projectPath &&
      answer.providerId === providerId,
    recheck,
  };
}

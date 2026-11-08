import { useEffect, useState } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { logDebug } from "@/utils/logger";
import type { ForgeNewPRLink, ForgeNewPRLinkRequest } from "@shared/types/ipc/forge";

const NO_ANSWER: ForgeNewPRLink = { state: "unavailable", term: "pull-request" };

interface UseNewPRLinkOptions extends ForgeNewPRLinkRequest {
  /** Only a chip on screen with no pull request has anything to ask about. */
  enabled: boolean;
  /**
   * Moves when the answer may have (a push, a fetch, a changed destination). A
   * move asks again with the last answer left standing until the new one lands.
   */
  revision: string;
}

/**
 * What the "No PR" chip can offer for this branch, or `null` before the first
 * answer about it. An answer about another branch or base is never shown, and a
 * failed lookup reads as nothing to offer rather than as an unpushed branch.
 */
export function useNewPRLink({
  enabled,
  revision,
  cwd,
  head,
  baseRef,
  isMainWorktree,
}: UseNewPRLinkOptions): ForgeNewPRLink | null {
  const identity = JSON.stringify([cwd, head, baseRef, isMainWorktree]);
  const [stored, setStored] = useState<{ identity: string; link: ForgeNewPRLink } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const link = await forgeClient.getNewPRLink({ cwd, head, baseRef, isMainWorktree });
        if (!cancelled) setStored({ identity, link });
      } catch (error) {
        logDebug("New pull request link lookup failed", { error });
        if (cancelled) return;
        setStored((last) => (last?.identity === identity ? last : { identity, link: NO_ANSWER }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, revision, identity, cwd, head, baseRef, isMainWorktree]);

  return stored?.identity === identity ? stored.link : null;
}

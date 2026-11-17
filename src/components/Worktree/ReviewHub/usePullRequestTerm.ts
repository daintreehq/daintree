import { useEffect, useState } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { logDebug } from "@/utils/logger";
import type { ForgePullRequestTerm } from "@shared/types/forge";

// A provider's word for a pull request doesn't change while it is registered,
// so each one is asked once per view.
const answered = new Map<string, ForgePullRequestTerm>();

/**
 * What the forge provider a pull request came from calls it. Reads as
 * "pull-request" until that provider has answered, and whenever it can't:
 * the wording every surface showed before a provider could say otherwise, so a
 * failed lookup costs nothing but the word.
 */
export function usePullRequestTerm(providerId: string | null): ForgePullRequestTerm {
  const [stored, setStored] = useState<{
    providerId: string;
    term: ForgePullRequestTerm;
  } | null>(null);

  useEffect(() => {
    if (!providerId || answered.has(providerId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const term = await forgeClient.getPullRequestTerm(providerId);
        if (term === null) return;
        answered.set(providerId, term);
        if (!cancelled) setStored({ providerId, term });
      } catch (error) {
        logDebug("Pull request term lookup failed", { error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  if (!providerId) return "pull-request";
  if (stored?.providerId === providerId) return stored.term;
  return answered.get(providerId) ?? "pull-request";
}

/** Test-only: forget every provider's answer. */
export function _resetPullRequestTermsForTest(): void {
  answered.clear();
}

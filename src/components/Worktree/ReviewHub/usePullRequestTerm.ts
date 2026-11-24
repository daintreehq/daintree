import { useEffect, useSyncExternalStore } from "react";
import { forgeClient } from "@/clients/forgeClient";
import { logDebug } from "@/utils/logger";
import type { ForgePullRequestTerm } from "@shared/types/forge";

// A provider's word for a pull request doesn't change while it is registered,
// so each one is asked once per view. Kept outside React and read through a
// subscription: an answer that lands for one consumer has to reach every other
// consumer of that provider, including one that rendered before it arrived.
const answered = new Map<string, ForgePullRequestTerm>();
const asking = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ask(providerId: string): void {
  if (answered.has(providerId) || asking.has(providerId)) return;
  asking.add(providerId);
  void (async () => {
    try {
      const term = await forgeClient.getPullRequestTerm(providerId);
      // `null` is a provider that can't be used right now; asked again next time.
      if (term === null) return;
      answered.set(providerId, term);
      for (const listener of listeners) listener();
    } catch (error) {
      logDebug("Pull request term lookup failed", { error });
    } finally {
      asking.delete(providerId);
    }
  })();
}

/**
 * What the forge provider a pull request came from calls it. Reads as
 * "pull-request" until that provider has answered, and whenever it can't:
 * the wording every surface showed before a provider could say otherwise, so a
 * failed lookup costs nothing but the word.
 */
export function usePullRequestTerm(providerId: string | null): ForgePullRequestTerm {
  const term = useSyncExternalStore(subscribe, () =>
    providerId ? answered.get(providerId) : undefined
  );

  useEffect(() => {
    if (providerId) ask(providerId);
  }, [providerId]);

  return term ?? "pull-request";
}

/** Test-only: forget every provider's answer. */
export function _resetPullRequestTermsForTest(): void {
  answered.clear();
  asking.clear();
}

import type { RecentDictation } from "@shared/types";
import { useRecentDictationsStore } from "@/store/recentDictationsStore";
import { logWarn } from "@/utils/logger";

// Failures are logged by kind only, and kept out of the global error report:
// the payloads are dictated text.

/** Hands a finished session to main's app-session history. */
export function keepRecentDictation(dictation: RecentDictation): void {
  Promise.resolve()
    .then(() => window.electron.recentDictations.record(dictation))
    .catch(() => logWarn("[RecentDictations] A finished dictation wasn't kept"));
}

/** Gives a kept session the text its cleanup returned. */
export function keepRecentDictationCorrection(id: string, correctedText: string): void {
  Promise.resolve()
    .then(() => window.electron.recentDictations.setCorrectedText({ id, correctedText }))
    .catch(() => logWarn("[RecentDictations] A dictation's cleanup wasn't kept"));
}

/**
 * Keeps this view's copy of the history current: read once now, then again on
 * every change any view makes. Returns the unsubscribe.
 */
export function subscribeRecentDictationsSync(): () => void {
  const api = typeof window === "undefined" ? undefined : window.electron?.recentDictations;
  if (!api) return () => {};
  let latest = 0;
  const refresh = () => {
    const request = ++latest;
    api
      .list()
      .then((dictations) => {
        if (request === latest) useRecentDictationsStore.getState().setDictations(dictations);
      })
      .catch(() => logWarn("[RecentDictations] Couldn't read recent dictations"));
  };
  const unsubscribe = api.onChanged(refresh);
  refresh();
  return () => {
    latest++;
    unsubscribe();
  };
}

import type { HelpSessionService } from "./HelpSessionService.js";

/**
 * HelpSessionService and the assistant content it reaches stay off the
 * startup path: the service loads with the first help call, provision or
 * deferred task that needs it. Code that runs before then reads it through
 * here instead of importing it. Only the service mints help tokens and records
 * lanes, so "not loaded" is the same answer as "no help session exists".
 */
let loaded: HelpSessionService | null = null;
const pending = new Set<(service: HelpSessionService) => void>();

/** The service if something has loaded it, without loading it. */
export function loadedHelpSessionService(): HelpSessionService | null {
  return loaded;
}

/**
 * Runs `apply` with the service as it finishes loading, before anything that
 * loaded it can call it, or now if it already has. Returns a cancel that is a
 * no-op once `apply` has run.
 */
export function whenHelpSessionServiceLoads(
  apply: (service: HelpSessionService) => void
): () => void {
  if (loaded) {
    apply(loaded);
    return () => {};
  }
  pending.add(apply);
  return () => {
    pending.delete(apply);
  };
}

/** Called once by HelpSessionService as its module finishes evaluating. */
export function publishHelpSessionService(service: HelpSessionService): void {
  loaded = service;
  for (const apply of [...pending]) {
    pending.delete(apply);
    try {
      apply(service);
    } catch (err) {
      console.warn("[helpSessionRuntime] Wiring the loaded HelpSessionService failed:", err);
    }
  }
}

export function resetHelpSessionRuntimeForTests(): void {
  loaded = null;
  pending.clear();
}

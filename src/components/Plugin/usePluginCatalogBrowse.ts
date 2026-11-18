import { useEffect, useState } from "react";
import type { PluginCatalogBrowseResult, PluginCatalogsBrowseResult } from "@shared/types/plugin";
import { logError } from "@/utils/logger";

/** What a read of the catalogs came back with: main's answer, or a call that failed outright. */
export type CatalogBrowseAnswer =
  { kind: "result"; result: PluginCatalogsBrowseResult } | { kind: "error" };

/**
 * A host running an older Daintree answers with Daintree's own catalog alone,
 * in the shape it had before added catalogs (#17434). Anything else reads as a
 * call that failed.
 */
function normalize(answer: unknown): CatalogBrowseAnswer {
  if (typeof answer !== "object" || answer === null) return { kind: "error" };
  if ("catalogs" in answer && Array.isArray(answer.catalogs)) {
    return { kind: "result", result: answer as PluginCatalogsBrowseResult };
  }
  if ("status" in answer) {
    return { kind: "result", result: { catalogs: [{ result: answer as PluginCatalogBrowseResult }] } };
  }
  return { kind: "error" };
}

/**
 * The plugin catalogs as the Browse view reads them (#16782, #17434). It asks
 * main once on mount, again on `retry`, and again when the person's list of
 * added catalogs changes in any window, and nowhere else: only an open Browse
 * view mounts it, so the manager opening, or the app starting, fetches
 * nothing. Main owns the caching, so asking again within its browse window
 * costs no request.
 *
 * An answer is kept with the attempt that asked for it, so a retry shows the
 * last answer as refreshing rather than blanking it, and a reply that lands
 * after the view went away or a newer attempt started is dropped.
 */
export function usePluginCatalogBrowse() {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ attempt: number; value: CatalogBrowseAnswer } | null>(
    null
  );

  useEffect(() => {
    let current = true;
    window.electron.plugin.browseCatalog().then(
      (result) => {
        if (current) setAnswer({ attempt, value: normalize(result) });
      },
      (err: unknown) => {
        if (!current) return;
        logError("Failed to read the plugin catalogs", err);
        setAnswer({ attempt, value: { kind: "error" } });
      }
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(
    () => window.electron.plugin.onCatalogSourcesChanged?.(() => setAttempt((n) => n + 1)),
    []
  );

  return {
    answer: answer?.value ?? null,
    refreshing: answer !== null && answer.attempt !== attempt,
    retry: () => setAttempt((n) => n + 1),
  };
}

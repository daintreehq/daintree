import { useEffect, useState } from "react";
import type { PluginCatalogBrowseResult } from "@shared/types/plugin";
import { logError } from "@/utils/logger";

/** What a read of the catalog came back with: main's answer, or a call that failed outright. */
export type CatalogBrowseAnswer =
  | { kind: "result"; result: PluginCatalogBrowseResult }
  | { kind: "error" };

/**
 * The community catalog as the Browse view reads it (#16782). It asks main once
 * on mount and again on `retry`, and nowhere else: only an open Browse view
 * mounts it, so the manager opening, or the app starting, fetches nothing. Main
 * owns the caching, so asking again within its browse window costs no request.
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
        if (current) setAnswer({ attempt, value: { kind: "result", result } });
      },
      (err: unknown) => {
        if (!current) return;
        logError("Failed to read the plugin catalog", err);
        setAnswer({ attempt, value: { kind: "error" } });
      }
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  return {
    answer: answer?.value ?? null,
    refreshing: answer !== null && answer.attempt !== attempt,
    retry: () => setAttempt((n) => n + 1),
  };
}

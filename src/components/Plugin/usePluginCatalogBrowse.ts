import { useEffect, useState } from "react";
import type {
  PluginCatalogBrowseResult,
  PluginCatalogFailure,
  PluginCatalogListing,
  PluginCatalogSourceBrowse,
} from "@shared/types/plugin";
import { logError } from "@/utils/logger";

/** Every catalog a Browse read covers: Daintree's own first, then each one added (#17434). */
export interface BrowsedCatalogs {
  catalogs: PluginCatalogSourceBrowse[];
}

/** What a read of the catalogs came back with: main's answer, or a call that failed outright. */
export type CatalogBrowseAnswer = { kind: "result"; result: BrowsedCatalogs } | { kind: "error" };

const FAILURES: ReadonlySet<unknown> = new Set<PluginCatalogFailure>([
  "not-published",
  "unreachable",
  "invalid",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isListing(value: unknown): value is PluginCatalogListing {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    typeof value.repo === "string" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((c) => typeof c === "string") &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === "string")
  );
}

/** One catalog's answer, checked down to each listing, so a broken reply can't break the pane. */
function isBrowseResult(value: unknown): value is PluginCatalogBrowseResult {
  if (!isRecord(value)) return false;
  if (value.status === "unavailable") return FAILURES.has(value.failure);
  if (value.status !== "available") return false;
  if (typeof value.fetchedAt !== "number" || typeof value.stale !== "boolean") return false;
  if (value.stale && !FAILURES.has(value.failure)) return false;
  return Array.isArray(value.listings) && value.listings.every(isListing);
}

function isSourceBrowse(value: unknown): value is PluginCatalogSourceBrowse {
  return (
    isRecord(value) &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === "string") &&
    isBrowseResult(value.result)
  );
}

/**
 * Daintree's own catalog in the shape it always had, and the added ones under
 * `added`. A host running an older Daintree answers without `added`; anything
 * that isn't a well-formed answer reads as a call that failed.
 */
function normalize(answer: unknown): CatalogBrowseAnswer {
  if (!isBrowseResult(answer)) return { kind: "error" };
  const added: unknown = "added" in answer ? answer.added : undefined;
  let extra: PluginCatalogSourceBrowse[] = [];
  if (added !== undefined) {
    if (!Array.isArray(added)) return { kind: "error" };
    extra = added.filter(isSourceBrowse);
    if (extra.length !== added.length) return { kind: "error" };
  }
  return { kind: "result", result: { catalogs: [{ result: answer }, ...extra] } };
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

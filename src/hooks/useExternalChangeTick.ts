import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileWatchFingerprintResult } from "@shared/types";
import { fileWatchClient } from "@/clients/fileWatchClient";
import { useSharedPollTick } from "@/hooks/useSharedPollTick";

/**
 * A live "something moved on disk" tick for paths no worktree covers.
 *
 * The worktree store is the authority wherever it has an answer — its tick
 * rides the workspace host's recursive watcher and is both cheaper and finer
 * than this. But a scratch folder, a worktree-less project and a file opened
 * from outside every registered repo have no host and no watcher, so those
 * surfaces had no tick to subscribe to at all and only ever refreshed on demand
 * (#11590). Callers compose the two: `worktreeTick ?? useExternalChangeTick(…)`,
 * keeping one tick contract for the consumer.
 *
 * Polled rather than pushed: main stays stateless, so there is no subscription
 * to leak when a view is evicted, and the sample is its own reconcile — no
 * dropped-overflow blind spot, and a deleted root reads as a change like
 * anything else.
 */

/**
 * Two seconds is under the threshold where a rewritten file reads as "the app
 * noticed", while being long enough that a pane sampling a handful of paths
 * costs nothing measurable. The interval only runs while the document is
 * visible, so a backgrounded project view polls nothing at all.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * Matches the per-call cap the channel's schema enforces. Paths are kept in the
 * order the caller supplied, so a caller with more than this many decides what
 * survives by listing the paths that matter first — the alternative (refusing
 * the batch) would turn a wide tree into no live signal at all.
 */
const MAX_WATCHED_PATHS = 32;

/** Shared empty identity so a caller can pass "nothing to watch" without churn. */
export const NO_WATCHED_PATHS: readonly string[] = Object.freeze([]);

export function useExternalChangeTick(
  rootPath: string,
  paths: readonly string[],
  enabled: boolean
): number | undefined {
  /**
   * The watched set, serialized. JSON rather than a delimiter join: a newline is
   * a legal character in a POSIX filename, so splitting on one would shred that
   * path into fragments that all fingerprint to `null` — a file that silently
   * never updates. Serializing here also gives the effects a primitive to key
   * on, so a caller re-deriving an equivalent array every render (which both
   * panes do) neither re-baselines nor re-requests.
   */
  const watchKey = useMemo(() => {
    if (!enabled || !rootPath) return "";
    const list: string[] = [];
    const seen = new Set<string>();
    for (const candidate of paths) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      list.push(candidate);
      if (list.length === MAX_WATCHED_PATHS) break;
    }
    return list.length === 0 ? "" : JSON.stringify(list);
  }, [enabled, rootPath, paths]);

  /**
   * The request payload, derived back from the key so everything downstream
   * depends on that one primitive. Deriving it here rather than returning it
   * alongside the key keeps a caller that rebuilds an equivalent array from
   * producing a fresh object identity, which would re-run the effects below and
   * re-baseline on every render.
   */
  const watchList = useMemo<string[]>(() => {
    if (watchKey === "") return [];
    const parsed: unknown = JSON.parse(watchKey);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  }, [watchKey]);

  const [tick, setTick] = useState<number | undefined>(undefined);

  // The last sample, and the identity it was taken for. Held in a ref rather
  // than state so recording a baseline doesn't itself cause a render.
  const baselineRef = useRef<{ key: string; root: string; sample: string } | null>(null);
  // Keeps a slow poll from overlapping the next interval.
  const inFlightRef = useRef(false);
  // Bumped whenever the watched set changes, so a response issued for the
  // previous set is recognizable on arrival. A closure comparison cannot do
  // this: `sample` captures the key it was built with, so checking that against
  // itself would always agree.
  const generationRef = useRef(0);

  const sample = useCallback(() => {
    if (!watchKey || inFlightRef.current) return;
    const key = watchKey;
    const root = rootPath;
    const generation = generationRef.current;
    let pending: Promise<FileWatchFingerprintResult>;
    try {
      pending = fileWatchClient.fingerprint({ rootPath: root, paths: watchList });
    } catch {
      // A pane can render before (or without) the preload bridge — a test
      // harness, a view torn down mid-render. Losing the live tick is a
      // degraded pane; throwing out of the effect would be a broken one.
      return;
    }
    inFlightRef.current = true;
    void pending
      .then((fingerprints) => {
        // The watched set changed while this was in flight: the answer describes
        // paths the caller is no longer showing, so emitting off it would make
        // the new set re-read for a change that happened to the old one.
        if (generation !== generationRef.current) return;
        // A separator no fingerprint can contain, so two different per-path
        // answers can never join to the same string.
        const next = fingerprints.map((value) => value ?? "-").join("");
        const previous = baselineRef.current;
        baselineRef.current = { key, root, sample: next };
        // The first sample of a set establishes what "unchanged" looks like and
        // deliberately emits nothing: the pane has just read these paths
        // explicitly, and a tick here would make it read them a second time.
        if (previous === null || previous.key !== key || previous.root !== root) return;
        if (previous.sample === next) return;
        // Wall-clock so the value composes with the worktree store's own
        // `lastUpdated`-shaped ticks, but forced upward: consumers treat a new
        // identity as the signal, and a clock correction that moved this
        // backwards onto a value already seen would drop the change.
        setTick((current) => Math.max(Date.now(), (current ?? 0) + 1));
      })
      .catch(() => {
        // A rejected sample (rate limit, teardown mid-call) leaves the baseline
        // untouched, so the next successful one still compares against real
        // prior state rather than restarting from scratch.
      })
      .finally(() => {
        // Only the current generation may release the latch: an abandoned
        // request settling later must not clear it out from under the request
        // that replaced it.
        if (generation === generationRef.current) inFlightRef.current = false;
      });
  }, [watchKey, watchList, rootPath]);

  // Baseline the new set now rather than one interval from now: everything that
  // happens between the pane's explicit read and the first sample would
  // otherwise be folded into the baseline and never reported.
  useEffect(() => {
    // Abandon whatever is in flight for the previous set and release the latch,
    // so the new set samples now rather than waiting out the old request.
    generationRef.current += 1;
    inFlightRef.current = false;
    if (!watchKey || document.hidden) return;
    sample();
  }, [watchKey, rootPath, sample]);

  // Pauses while the document is hidden and re-samples immediately on reveal —
  // which is what keeps a change that landed while a project view was
  // backgrounded from needing a manual refresh to surface.
  //
  // Shared rather than per-pane: every file surface polls at this same cadence,
  // and one ticker puts their requests in the same task so Main's coalescing
  // sampler folds them onto one read per path. With an interval each, their
  // phases drift and the same paths get read once per pane per cycle.
  useSharedPollTick(sample, POLL_INTERVAL_MS, watchKey !== "");

  return watchKey === "" ? undefined : tick;
}

import { useEffect, useRef, useState, type RefObject } from "react";

/** A row this much in view, for this long, counts as looked at. */
const VIEWED_RATIO = 0.5;
export const CANOPY_VIEWED_DWELL_MS = 1000;

/**
 * The runs whose rows have sat at least half in view of the list's scroller for
 * a second while the window had focus. A row scrolled out of view leaves the
 * set; one the user has not scrolled to never enters it.
 */
export function useCanopyRowsViewed(
  scrollerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** The runs the list can show, space-separated. */
  rowsKey: string,
  /** What else moves a row's element without moving its place among the runs. */
  layoutKey: string,
  domIdOf: (runId: string) => string,
  /** Told the moment a row's second is up, ahead of the state it also lands in: a close can't outrun it. */
  onViewed: (runId: string) => void
): ReadonlySet<string> {
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());

  const onViewedRef = useRef(onViewed);
  useEffect(() => {
    onViewedRef.current = onViewed;
  }, [onViewed]);

  useEffect(() => {
    if (!enabled) setViewed((prev) => (prev.size === 0 ? prev : new Set()));
  }, [enabled]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller || typeof IntersectionObserver === "undefined") return;
    const runOfDomId = new Map<string, string>();
    for (const runId of rowsKey === "" ? [] : rowsKey.split(" "))
      runOfDomId.set(domIdOf(runId), runId);
    const inView = new Set<string>();
    const timers = new Map<string, number>();

    // Started afresh with each list: a run filtered out and back, or given a new
    // prompt while the window was away, earns its second again.
    setViewed((prev) => (prev.size === 0 ? prev : new Set()));

    const settle = (runId: string) => {
      timers.delete(runId);
      onViewedRef.current(runId);
      setViewed((prev) => (prev.has(runId) ? prev : new Set(prev).add(runId)));
    };
    const consider = (runId: string) => {
      if (timers.has(runId) || !inView.has(runId) || !document.hasFocus()) return;
      timers.set(
        runId,
        window.setTimeout(() => settle(runId), CANOPY_VIEWED_DWELL_MS)
      );
    };
    const drop = (runId: string) => {
      const timer = timers.get(runId);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(runId);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const left: string[] = [];
        for (const entry of entries) {
          const runId = runOfDomId.get(entry.target.id);
          if (runId === undefined) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= VIEWED_RATIO) {
            inView.add(runId);
            consider(runId);
          } else {
            inView.delete(runId);
            drop(runId);
            left.push(runId);
          }
        }
        if (left.length > 0) {
          setViewed((prev) => {
            if (!left.some((runId) => prev.has(runId))) return prev;
            const next = new Set(prev);
            for (const runId of left) next.delete(runId);
            return next;
          });
        }
      },
      { root: scroller, threshold: [0, VIEWED_RATIO] }
    );
    for (const domId of runOfDomId.keys()) {
      const el = document.getElementById(domId);
      if (el && scroller.contains(el)) observer.observe(el);
    }

    const onFocus = () => {
      for (const runId of inView) consider(runId);
    };
    const onBlur = () => {
      setViewed((prev) => (prev.size === 0 ? prev : new Set()));
      for (const runId of [...timers.keys()]) drop(runId);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      observer.disconnect();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, [enabled, scrollerRef, rowsKey, layoutKey, domIdOf]);

  return viewed;
}

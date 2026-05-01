import { useEffect, useState, type RefObject } from "react";

// Chromium 130+ subpixel rounding can land fully-visible elements at
// intersectionRatio ≈ 0.9999 instead of 1.0 on high-DPI displays — observe at
// 0.98 and rely on isIntersecting (not strict equality with 1).
const VISIBILITY_THRESHOLD = 0.98;

/**
 * Tracks which descendants of `containerRef` are clipped by horizontal
 * overflow. Children must carry `data-tab-id="<id>"` — the hook queries for
 * those nodes inside the container, observes their intersection with the
 * container's viewport, and returns the set of ids that are currently hidden.
 *
 * Re-observes whenever the `tabIds` array changes so newly-added or reordered
 * tabs participate in the next visibility check.
 */
export function useTabOverflow(
  containerRef: RefObject<HTMLElement | null>,
  tabIds: readonly string[]
): ReadonlySet<string> {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  // Memoize the dependency by joining ids — useEffect uses referential equality
  // and a new array each render would re-run the effect every render.
  const tabIdsKey = tabIds.join("|");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        setHiddenIds((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.tabId;
            if (!id) continue;
            if (entry.isIntersecting) {
              if (next.delete(id)) changed = true;
            } else if (!next.has(id)) {
              next.add(id);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: container, threshold: VISIBILITY_THRESHOLD }
    );

    const observed = container.querySelectorAll<HTMLElement>("[data-tab-id]");
    observed.forEach((el) => observer.observe(el));

    // Reconcile to only currently-known tab ids — drops any stale entries from
    // tabs that have been removed since the previous run.
    const known = new Set(tabIds);
    setHiddenIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (known.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });

    return () => observer.disconnect();
  }, [containerRef, tabIdsKey, tabIds]);

  return hiddenIds;
}

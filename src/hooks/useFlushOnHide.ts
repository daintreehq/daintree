import { useEffect, useLayoutEffect, useRef } from "react";
import { isProjectViewCached, subscribeProjectViewCachedFlush } from "@/lib/viewCacheState";

/**
 * Calls `fn` when nobody can see this view any more and `enabled` is true:
 * main caching it, or the window being hidden.
 *
 * Neither event alone covers both. `WebContentsView` detach fires no
 * `beforeunload`, and a cached view never gets `visibilitychange` either — it
 * reports `"visible"` forever (see `viewCacheState`) — so main's cached signal
 * is what tracks a project switch. Minimizing the window still flips
 * `document.hidden`. On the cached edge main keeps the view unfrozen and
 * resident until the promise `fn` returns settles, within a bounded wait, so a
 * multi-step async flush reaches main before a freeze or eviction can cut it
 * short.
 *
 * The callback is held in a ref so unstable references (recreated each
 * render) always invoke the latest closure. Each callback is responsible
 * for its own error handling, and for coalescing triggers that overlap.
 */
export function useFlushOnHide(fn: () => void | Promise<void>, enabled: boolean): void {
  const callbackRef = useRef(fn);
  useLayoutEffect(() => {
    callbackRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;

    const flush = () => callbackRef.current();
    const handler = () => {
      if (!document.hidden) return;
      void flush();
    };

    document.addEventListener("visibilitychange", handler);
    const offCached = subscribeProjectViewCachedFlush(flush);
    // Cover mounting (or enabling) when the view is already hidden or cached:
    // both signals are edges, and a fast switch can land before this effect.
    if (document.hidden || isProjectViewCached()) {
      void flush();
    }

    return () => {
      document.removeEventListener("visibilitychange", handler);
      offCached();
    };
  }, [enabled]);
}

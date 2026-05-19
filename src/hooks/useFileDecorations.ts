import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDecoration } from "@shared/types/forge";
import { logWarn } from "@/utils/logger";

/**
 * Stable empty result. Returning the same object identity when there are no
 * decorations keeps consumers' `useMemo`/`useEffect` deps from thrashing.
 */
const EMPTY: Readonly<Record<string, FileDecoration>> = Object.freeze({});

/**
 * Subscribe to plugin-contributed file decorations for `scope` over `paths`.
 *
 * The host knows nothing about what a decoration means — a plugin (e.g. the
 * built-in GitHub plugin for `worktree-diff:*`) supplies badge/tooltip/color
 * per path; this hook just renders whatever it gets.
 *
 * Data flow mirrors `usePluginPanelKinds`: pull on mount and whenever
 * `scope`/`paths` change, plus a lightweight push subscription
 * (`plugin:decorations-changed`) that re-pulls when a matching scope is
 * invalidated. The push payload carries only keys, never decoration data, so
 * the renderer always fetches fresh values for exactly the visible paths.
 * Pull-on-mount is the safety net for cached `WebContentsView`s that missed a
 * broadcast.
 */
export function useFileDecorations(scope: string, paths: string[]): Record<string, FileDecoration> {
  // Deduplicate + stabilize so an array with identical contents but a new
  // identity does not retrigger the fetch effect every render.
  const cleanPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const p of paths) {
      if (typeof p === "string" && p.length > 0) seen.add(p);
    }
    return [...seen].sort();
  }, [paths]);
  const pathsKey = cleanPaths.join("\n");

  const [decorations, setDecorations] = useState<Record<string, FileDecoration>>(EMPTY);

  // Keep the latest path set readable from the subscription callback without
  // making it a dependency (the callback is registered once per scope).
  const pathsRef = useRef<string[]>(cleanPaths);
  pathsRef.current = cleanPaths;

  useEffect(() => {
    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin || scope.length === 0) {
      setDecorations(EMPTY);
      return;
    }
    if (pathsRef.current.length === 0) {
      setDecorations(EMPTY);
      return;
    }

    let disposed = false;
    let requestId = 0;

    const fetchDecorations = (): void => {
      const current = ++requestId;
      const requested = pathsRef.current;
      if (requested.length === 0) {
        setDecorations(EMPTY);
        return;
      }
      void electron.plugin
        .getDecorations(scope, requested)
        .then((result) => {
          if (disposed || current !== requestId) return;
          setDecorations(result && Object.keys(result).length > 0 ? result : EMPTY);
        })
        .catch((err: unknown) => {
          if (disposed || current !== requestId) return;
          logWarn("[FileDecorations] Failed to fetch decorations", {
            scope,
            error: err,
          });
          setDecorations(EMPTY);
        });
    };

    fetchDecorations();

    const cleanup = electron.plugin.onDecorationsChanged((payload) => {
      if (payload.scope !== scope) return;
      // No path narrowing, or the invalidated paths intersect what we show →
      // re-pull. An empty intersection means nothing visible changed.
      if (payload.paths && payload.paths.length > 0) {
        const visible = new Set(pathsRef.current);
        if (!payload.paths.some((p) => visible.has(p))) return;
      }
      fetchDecorations();
    });

    return () => {
      disposed = true;
      cleanup();
    };
    // `pathsKey` is the stable trigger (the deduped+sorted join). `cleanPaths`
    // itself is intentionally NOT a dep — it gets a fresh identity every
    // render (its memo depends on the caller's array identity), so including
    // it would re-run this effect every render and let a later stale fetch
    // overwrite a fresh result. The current path set is read off `pathsRef`.
  }, [scope, pathsKey]);

  return decorations;
}

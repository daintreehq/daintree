import { lazy, useEffect, useState, type ComponentType } from "react";

/**
 * `React.lazy` that renders synchronously once its chunk has been preloaded.
 *
 * A plain `lazy()` suspends on its first render even when the chunk was
 * imported moments earlier: it only learns the module resolved through its
 * own promise's `.then`. That suspension commits the Suspense fallback, and
 * React 19 then holds the content back until 300ms after the fallback
 * committed (FALLBACK_THROTTLE_MS) — so every first open of a preloaded
 * palette, dialog, tab or panel read ~315ms instead of one frame.
 *
 * `preload()` records the resolved component; a render that finds it renders
 * it directly and never suspends. Anything rendered before the chunk lands
 * still goes through the lazy path and its Suspense boundary. Each instance
 * keeps the type it mounted with, so a resolve mid-life never remounts it.
 */
export type PreloadableComponent<P, M> = ComponentType<P> & {
  preload: () => Promise<M>;
  /** True once the chunk has resolved — a render now cannot suspend. */
  isLoaded: () => boolean;
};

export function lazyWithPreload<M, P extends object>(
  load: () => Promise<M>,
  pick: (mod: M) => ComponentType<P>
): PreloadableComponent<P, M> {
  let resolvedModule: M | null = null;
  let resolved: ComponentType<P> | null = null;
  let inFlight: Promise<M> | null = null;

  const preload = (): Promise<M> => {
    if (resolvedModule !== null) return Promise.resolve(resolvedModule);
    inFlight ??= load().then(
      (mod) => {
        resolvedModule = mod;
        resolved = pick(mod);
        inFlight = null;
        return mod;
      },
      (err: unknown) => {
        inFlight = null;
        throw err;
      }
    );
    return inFlight;
  };

  const Lazy = lazy(() => preload().then((mod) => ({ default: pick(mod) })));

  function Preloadable(props: P) {
    const [Component] = useState<ComponentType<P>>(() => resolved ?? Lazy);
    return <Component {...props} />;
  }

  return Object.assign(Preloadable, { preload, isLoaded: () => resolved !== null });
}

export type PreloadStatus =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; error: unknown };

/**
 * Whether `component` can render now without suspending, loading its chunk
 * when it can't yet.
 *
 * For a host that draws its own placeholder while the chunk loads instead of
 * going through Suspense: a plain state update commits the moment the chunk
 * lands, where a Suspense fallback holds the reveal back for React 19's
 * 300ms throttle. A failed load is reported rather than thrown, so the host
 * keeps its chrome around the failure; the next mount tries again. Pass a
 * component that lives at module or factory scope.
 */
export function usePreloadedComponent(component: {
  preload: () => Promise<unknown>;
  isLoaded: () => boolean;
}): PreloadStatus {
  const [state, setState] = useState<PreloadStatus>(() =>
    component.isLoaded() ? { status: "ready" } : { status: "loading" }
  );
  const loading = state.status === "loading";
  useEffect(() => {
    if (!loading) return;
    let live = true;
    component.preload().then(
      () => {
        if (live) setState({ status: "ready" });
      },
      (error: unknown) => {
        if (live) setState({ status: "failed", error });
      }
    );
    return () => {
      live = false;
    };
  }, [component, loading]);
  return state;
}

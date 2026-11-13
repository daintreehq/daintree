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
  // The module and the component picked from it land together, and `pick`
  // runs once per module: a picker that builds a component (a factory) must
  // not hand the lazy path a second type.
  let loaded: { module: M; component: ComponentType<P> } | null = null;
  let inFlight: Promise<{ module: M; component: ComponentType<P> }> | null = null;

  const settle = () => {
    if (loaded !== null) return Promise.resolve(loaded);
    inFlight ??= load()
      .then((module) => (loaded = { module, component: pick(module) }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const preload = (): Promise<M> => settle().then(({ module }) => module);

  const Lazy = lazy(() => settle().then(({ component }) => ({ default: component })));

  function Preloadable(props: P) {
    const [Component] = useState<ComponentType<P>>(() => loaded?.component ?? Lazy);
    return <Component {...props} />;
  }

  return Object.assign(Preloadable, { preload, isLoaded: () => loaded !== null });
}

export type PreloadStatus =
  { status: "loading" } | { status: "ready" } | { status: "failed"; error: unknown };

/**
 * Whether `component` can render now without suspending, loading its chunk
 * when it can't yet.
 *
 * For a host that draws its own placeholder while the chunk loads instead of
 * going through Suspense: a plain state update commits the moment the chunk
 * lands, where a Suspense fallback holds the reveal back for React 19's
 * 300ms throttle. A failed load is reported rather than thrown, so the host
 * keeps its chrome around the failure; the next mount tries again. Meant for
 * a component that lives at module or factory scope; a different one starts
 * over rather than inherit the last one's answer.
 */
export function usePreloadedComponent(component: PreloadTarget): PreloadStatus {
  const [settled, setSettled] = useState<{ target: PreloadTarget; status: PreloadStatus }>(() => ({
    target: component,
    status: initialPreloadStatus(component),
  }));
  const status = settled.target === component ? settled.status : initialPreloadStatus(component);
  const loading = status.status === "loading";
  useEffect(() => {
    if (!loading) return;
    let live = true;
    component.preload().then(
      () => {
        if (live) setSettled({ target: component, status: { status: "ready" } });
      },
      (error: unknown) => {
        if (live) setSettled({ target: component, status: { status: "failed", error } });
      }
    );
    return () => {
      live = false;
    };
  }, [component, loading]);
  return status;
}

interface PreloadTarget {
  preload: () => Promise<unknown>;
  isLoaded: () => boolean;
}

function initialPreloadStatus(component: PreloadTarget): PreloadStatus {
  return component.isLoaded() ? { status: "ready" } : { status: "loading" };
}

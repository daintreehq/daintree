import { lazy, useState, type ComponentType } from "react";

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

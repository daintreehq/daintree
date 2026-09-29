import { createElement, lazy, useMemo, useState, type ComponentType } from "react";

/**
 * A component from {@link lazyWithPreload}: renders like `React.lazy`, plus
 * `preload()` to fetch its chunk ahead of the first render.
 */
export type PreloadableComponent<P, M = unknown> = ComponentType<P> & {
  /** Start (or join) the chunk load. A rejected load is retried by the next call. */
  preload: () => Promise<M>;
  /** True once the chunk has resolved, so a render now cannot suspend. */
  isLoaded: () => boolean;
};

/**
 * `React.lazy` that renders synchronously once its chunk has been preloaded.
 *
 * A plain `lazy()` suspends on its first render even when the chunk was
 * imported moments earlier, and React 19 then holds the Suspense content back
 * for its 300ms fallback throttle — so a preloaded dialog or tab still opens a
 * third of a second late. Here `preload()` records the resolved component and a
 * render that finds it renders it directly. Anything rendered before the chunk
 * lands suspends as usual. Each mounted instance keeps the type it mounted
 * with, so a load resolving mid-life never remounts it.
 *
 * ```tsx
 * const Settings = lazyWithPreload(() => import("./Settings.js"));
 * // or pick a named export:
 * const Chart = lazyWithPreload(() => import("./charts.js"), (m) => m.Chart);
 * <button {...usePreloadOnIntent(Settings)} onClick={open}>Settings</button>
 * ```
 */
export function lazyWithPreload<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>
): PreloadableComponent<P, { default: ComponentType<P> }>;
export function lazyWithPreload<M, P extends object>(
  load: () => Promise<M>,
  pick: (mod: M) => ComponentType<P>
): PreloadableComponent<P, M>;
export function lazyWithPreload<M, P extends object>(
  load: () => Promise<M>,
  pick: (mod: M) => ComponentType<P> = (mod) => (mod as { default: ComponentType<P> }).default
): PreloadableComponent<P, M> {
  let loaded: { mod: M; component: ComponentType<P> } | null = null;
  let inFlight: Promise<M> | null = null;

  const preload = (): Promise<M> => {
    if (loaded) return Promise.resolve(loaded.mod);
    // `pick` runs inside the chain so a throwing pick is retried like a failed load.
    inFlight ??= load()
      .then((mod) => {
        loaded = { mod, component: pick(mod) };
        return mod;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const Lazy = lazy(() => preload().then(() => ({ default: loaded!.component })));

  function Preloadable(props: P) {
    const [Component] = useState<ComponentType<P>>(() => loaded?.component ?? Lazy);
    return createElement(Component as ComponentType<object>, props);
  }

  return Object.assign(Preloadable, { preload, isLoaded: () => loaded !== null });
}

/** Handlers returned by {@link usePreloadOnIntent}; spread them onto the trigger element. */
export interface PreloadIntentHandlers {
  onPointerEnter: () => void;
  onFocus: () => void;
}

/**
 * Preload a lazy component when the user shows intent — pointer over or focus
 * on the control that opens it — so the chunk is usually in hand by the click.
 * A failed preload is swallowed here: the render that needs the component
 * retries the load and surfaces the error through its own boundary.
 */
export function usePreloadOnIntent(target: {
  preload: () => Promise<unknown>;
}): PreloadIntentHandlers {
  return useMemo(() => {
    const warm = (): void => {
      target.preload().catch(() => {});
    };
    return { onPointerEnter: warm, onFocus: warm };
  }, [target]);
}

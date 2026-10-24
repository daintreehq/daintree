import { createElement, type ComponentType, type ProfilerOnRenderCallback } from "react";
import type { PanelViewProps } from "@shared/types/plugin";
import { usePluginRuntimeStatusStore } from "@/store/pluginRuntimeStatusStore";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import { preparePluginStyles } from "@/services/plugin/pluginStyleContract";
import {
  generationOfViewUrl,
  measurePluginViewPhase,
  pluginViewMetrics,
  type PluginViewPhase,
} from "@/services/plugin/pluginViewMetrics";
import { markRendererPerformance } from "@/utils/performance";
import { PERF_MARKS } from "@shared/perf/marks";
import { pluginViewHostId, pluginViewImportPath } from "./remotePluginView";
import { PluginViewBlockedError } from "./PluginViewBlockedPlaceholder";

/**
 * Upper bound on a single `plugin://` view import before the host gives up and
 * surfaces the ErrorBoundary's retry. Generous enough to cover a cold protocol
 * handler start; short enough that a genuinely wedged load doesn't strand the
 * user on an indefinite skeleton (#10512).
 */
const PLUGIN_VIEW_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Errors raised by the `plugin://` module fetch itself (or by the timeout that
 * fires while one is in flight), as opposed to an activation rejection or a
 * throw from the view's own render. Only these are worth recovering with a fresh
 * view generation: the module map keys failures by specifier and never evicts
 * them, so re-importing the same URL after a fetch failure is guaranteed to fail
 * again. A module that loaded but exported the wrong shape, or a view that threw
 * while rendering, would fail identically on a new specifier — those keep the
 * plain remount. Tracked in a WeakSet rather than a flag on the error so the
 * error object the boundary logs and displays stays untouched.
 */
const importStageFailures = new WeakSet<WeakKey>();

function isWeakKey(value: unknown): value is WeakKey {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Mark a module-fetch failure and return the value to throw. A module is free to
 * `throw "boom"` (or `null`) during evaluation, and `import()` rejects with that
 * exact value — which cannot key a WeakSet. Those rejections are wrapped in a
 * real Error carrying the original as `cause`, so the classification survives
 * and the boundary gets something it can actually render. Object and function
 * rejections are marked in place, leaving the error identity untouched.
 */
function markImportStageFailure(err: unknown): unknown {
  const marked = isWeakKey(err)
    ? err
    : new Error(`Plugin view module failed to load: ${String(err)}`, { cause: err });
  importStageFailures.add(marked);
  return marked;
}

export function isImportStageFailure(err: unknown): boolean {
  return isWeakKey(err) && importStageFailures.has(err);
}

/**
 * One attempt's load timings, filled in by its load and completed by the paint
 * reporter once the view has actually painted. Owned by the attempt, so the
 * timings live exactly as long as it does.
 */
export interface ViewLoadTiming {
  openedAt: number;
  retry: boolean;
  activateMs: number;
  importMs: number;
  stylesMs: number;
  /** Open → module imported and styles ready; the `view-load` phase. */
  loadMs: number;
  recorded: boolean;
}

/**
 * One mount attempt of a plugin view. The view arrives through `run`, which the
 * content calls from an effect and which settles into plain component state —
 * never a Suspense retry, so nothing waits on React's reveal throttle. A warm
 * attempt's `run` only waits on activation, so it shows within one IPC round
 * trip. `run` is memoized per attempt.
 */
export interface ViewAttempt {
  timing: ViewLoadTiming;
  run: () => Promise<ComponentType<PanelViewProps>>;
}

/** What an attempt's load settled to, tagged with the attempt it belongs to. */
export type SettledAttempt =
  | { attempt: ViewAttempt; failed: false; view: ComponentType<PanelViewProps> }
  | { attempt: ViewAttempt; failed: true; error: unknown };

/**
 * `markRendererPerformance` also lands a User Timing mark under capture, and
 * these fire on every open, so the previous mark of the same name is cleared
 * first to keep the browser's buffer at one per phase. The capture buffer
 * itself is bounded by `markRendererPerformance`.
 */
function markPluginView(mark: string, meta: Record<string, unknown>): void {
  try {
    performance.clearMarks?.(mark);
  } catch {
    // Clearing is housekeeping; the mark below still matters more.
  }
  markRendererPerformance(mark, meta);
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function isPluginViewModule(mod: unknown): mod is { default: ComponentType<PanelViewProps> } {
  if (mod === null || typeof mod !== "object") return false;
  const candidate = (mod as { default?: unknown }).default;
  // Accept any React element type — function components, `memo(...)`,
  // `forwardRef(...)`, and lazy/class wrappers are all valid defaults.
  // `memo` and `forwardRef` return objects (typeof === "object"), not
  // functions, so a `typeof === "function"`-only check would reject common
  // optimization patterns.
  return typeof candidate === "function" || (typeof candidate === "object" && candidate !== null);
}

export interface PluginViewLoaderConfig {
  componentPath: string;
  pluginId: string;
  kindId: string;
}

export interface PluginViewLoader {
  createAttempt: (
    requestRecoveryPath: boolean,
    builtinComponent: ComponentType<PanelViewProps> | null,
    retry: boolean
  ) => ViewAttempt;
  forgetActivation: () => void;
  scheduleFirstPaintSample: (timing: ViewLoadTiming) => () => void;
  onViewCommit: ProfilerOnRenderCallback;
}

/**
 * The load state one content factory shares across every panel it mounts:
 * the recovery specifier, the last loaded module, and the backend activation
 * reached. Built once per `makePluginViewContent` call, so these caches live
 * exactly as long as the factory that `usePluginPanelKinds` keeps per
 * `(kindId, componentPath)` — never module-global, never per render.
 */
export function createPluginViewLoader({
  componentPath,
  pluginId,
  kindId,
}: PluginViewLoaderConfig): PluginViewLoader {
  // The load this factory's views belong to. Every observation carries it, so
  // one a replaced load's view makes after its successor mounted is dropped
  // instead of being counted against the new load.
  const viewGeneration = generationOfViewUrl(componentPath);

  // Replacement specifier for `componentPath` once main has minted one, cached at
  // factory scope so it outlives both the attempt and the component
  // instance (#11728). A remount that fell back to the poisoned original would
  // undo the recovery, and `usePluginPanelKinds` caches this factory per
  // (kindId, componentPath) — so every panel of this kind shares the one
  // recovery generation, which is exactly the granularity main mints it at.
  let recoveryComponentPath: string | undefined;

  /**
   * The last module this factory's views loaded, and the worker it was
   * activated against. Factory scope, like `recoveryComponentPath`, so a panel
   * closed and reopened (or reloaded, or moved between hosts) can render the
   * view in the commit that mounts it instead of waiting on an activation round
   * trip that main answers immediately. Waiting is what cost every open React's
   * 300 ms Suspense reveal throttle: the fallback committed, and the retry that
   * revealed the view was held until 300 ms after it.
   */
  let loadedModule: { path: string; view: ComponentType<PanelViewProps> } | null = null;
  const builtinViews = new WeakMap<ComponentType<PanelViewProps>, ComponentType<PanelViewProps>>();
  /**
   * The backend a settled activation left behind: the worker generation that
   * was `ready` when it resolved, or `null` for a plugin with no worker (a
   * builtin, which activates in-process). Absent means nothing is known to be
   * live, and the next attempt activates before it renders (#10523).
   */
  let activatedAgainst: { worker: number | null } | undefined;

  const forgetActivation = (): void => {
    activatedAgainst = undefined;
  };

  const rememberActivation = (inProcess: boolean): void => {
    const status = usePluginRuntimeStatusStore.getState().statusById.get(pluginId);
    const worker = status?.worker;
    // Main publishes no status at all for a builtin with no worker or dev
    // session, so absence is its normal state. Its activation lives as long as
    // this load: a disable unloads it, and the reload an enable performs mints a
    // new view generation — a new `componentPath`, so a new factory.
    if (!status) activatedAgainst = inProcess ? { worker: null } : undefined;
    else if (worker === null) activatedAgainst = { worker: null };
    else if (worker?.state === "ready") activatedAgainst = { worker: worker.generation };
    // Settled while the pushed status still shows a transient state: which
    // backend answered is unknown, so the next attempt waits for it again.
    else activatedAgainst = undefined;
  };

  /**
   * Whether the backend the last activation reached is still the one running.
   * Read from the pushed runtime status, which is the only renderer-side
   * account of a worker restart, an idle dispose (`stopped`), or a plugin reload
   * that published this kind under a newer view generation. Anything it cannot
   * confirm is treated as not live, so the cost of a wrong answer is one
   * activation-first load. What it cannot see is a transition main has made
   * but whose push is still in flight; a view opened inside that window
   * renders ahead of the replacement's `activate()`, and the push that lands
   * next either fails the view (a refused activation) or rebinds it onto the
   * new worker, which remounts it.
   */
  const backendIsLive = (inProcess: boolean): boolean => {
    if (!activatedAgainst) return false;
    const status = usePluginRuntimeStatusStore.getState().statusById.get(pluginId);
    if (!status) return inProcess && activatedAgainst.worker === null;
    const publishedGeneration = viewGeneration?.order ?? null;
    if (publishedGeneration !== null && status.viewGeneration !== publishedGeneration) return false;
    const worker = status.worker;
    if (activatedAgainst.worker === null) return worker === null;
    return (
      worker !== null && worker.state === "ready" && worker.generation === activatedAgainst.worker
    );
  };

  /**
   * Resolves once every kit primitive renders synchronously. Started alongside
   * activation so the chunk loads in parallel with it, and awaited with the
   * styles: a kit control that mounts before the chunk is in suspends inside
   * its own boundary, and that boundary's reveal is throttled exactly like the
   * one this load path avoids. A kit that fails to load is the kit's own
   * boundary's problem, so this never rejects.
   */
  const whenKitReady = (): Promise<void> =>
    import("@/pluginUi").then((kit) => kit.whenPluginUiReady()).catch(() => {});

  const startTiming = (retry: boolean): ViewLoadTiming => {
    const timing: ViewLoadTiming = {
      openedAt: performance.now(),
      retry,
      activateMs: 0,
      importMs: 0,
      stylesMs: 0,
      loadMs: 0,
      recorded: false,
    };
    markPluginView(PERF_MARKS.PLUGIN_VIEW_LOAD_START, { pluginId, kindId, retry });
    return timing;
  };

  const endPhase = (phase: PluginViewPhase, start: number): number => {
    const end = performance.now();
    measurePluginViewPhase(pluginId, phase, start, end, { kindId });
    return end - start;
  };

  // Factory scope, so the Profiler sees one stable callback and the view's
  // commits cost a single registry push each. Production react-dom never calls
  // it (only development and profiling builds do); the rest of the load timing
  // does not depend on it.
  const onViewCommit: ProfilerOnRenderCallback = (
    _id,
    _phase,
    actualDuration,
    _baseDuration,
    _startTime,
    commitTime
  ) => {
    pluginViewMetrics.recordCommit(pluginId, actualDuration, commitTime, viewGeneration);
  };

  /**
   * Race one attempt's activation and load against the import timeout. A wedged
   * protocol load (handler hang, never-resolving fetch) would otherwise leave
   * the pane loading forever — the ErrorBoundary only sees rejections, never a
   * pending promise. Rejecting on timeout routes to the boundary's "Try again",
   * and because the race is per attempt a retry restarts the timer cleanly
   * (#10512). Activation and import share the one timeout so a stalled
   * `activate()` surfaces the same recovery path as a stalled import.
   */
  const withLoadTimeout = <T>(work: Promise<T>, timeoutError: () => unknown): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      work.finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError()), PLUGIN_VIEW_IMPORT_TIMEOUT_MS);
      }),
    ]);
  };

  /**
   * The view a builtin's registered component renders through. A builtin keeps
   * its view out of the host bundle by registering a `lazy()` component, which
   * suspends on its own chunk inside this content's boundary; rendering it from
   * a plain component keeps that working. `createElement`, not JSX: the React
   * Compiler folds a capitalised alias of a lowercase binding back into the
   * binding, and `<component />` then renders an intrinsic element. One wrapper
   * per registered component, so a warm attempt reuses the one already built.
   */
  const builtinViewFor = (
    component: ComponentType<PanelViewProps>
  ): ComponentType<PanelViewProps> => {
    const existing = builtinViews.get(component);
    if (existing) return existing;
    const BuiltinPanelView = (props: PanelViewProps) => createElement(component, props);
    builtinViews.set(component, BuiltinPanelView);
    return BuiltinPanelView;
  };

  /**
   * A built-in plugin's panel view is compiled into the host bundle and
   * registered in-process under this kind id (#11244), so there is no module to
   * fetch. It still goes through the same activation + timeout, so the plugin's
   * `activate()` has run before first render and the loading, failure, and
   * retry paths are the ones an installed view gets. Recovery never asks main
   * for a fresh `plugin://` generation: nothing was imported, so there is no
   * poisoned specifier to replace.
   */
  const loadBuiltinView = async (
    component: ComponentType<PanelViewProps>,
    timing: ViewLoadTiming
  ): Promise<ComponentType<PanelViewProps>> => {
    const kitReady = whenKitReady();
    await withLoadTimeout(
      (async () => {
        const activateStart = performance.now();
        try {
          await window.electron?.plugin?.activateForView?.(kindId);
        } catch (err) {
          forgetActivation();
          throw err;
        }
        rememberActivation(true);
        timing.activateMs = endPhase("activate", activateStart);
        markPluginView(PERF_MARKS.PLUGIN_VIEW_ACTIVATED, { pluginId, kindId });
        await kitReady;
      })(),
      () =>
        new Error(
          `Plugin "${pluginId}" view activation timed out after ${PLUGIN_VIEW_IMPORT_TIMEOUT_MS}ms`
        )
    );
    const view = builtinViewFor(component);
    timing.loadMs = endPhase("view-load", timing.openedAt);
    markPluginView(PERF_MARKS.PLUGIN_VIEW_IMPORTED, { pluginId, kindId });
    return view;
  };

  const loadModuleView = async (
    requestRecoveryPath: boolean,
    timing: ViewLoadTiming
  ): Promise<ComponentType<PanelViewProps>> => {
    // A host's view runs here only once this computer says so. The question
    // is settled before the load deadline starts, so reading it can't time
    // the view out, and it is parented to this window.
    if (pluginViewHostId() !== null) {
      const url = pluginViewImportPath(recoveryComponentPath ?? componentPath);
      const allowed = await window.electron?.remoteHosts?.preparePluginView?.({ url });
      if (allowed !== true) throw new PluginViewBlockedError(pluginId);
    }
    const mod: unknown = await withLoadTimeout(
      (async () => {
        // Implicit lazy activation (#10523): force the owning plugin to
        // `activate()` before importing its module, so handlers it registers
        // during activate() are live when the view first renders. Optional
        // chaining keeps this working in test environments without
        // `window.electron`. `activateForView` is a no-op once the plugin is
        // already activated.
        //
        // On activation failure the IPC call now REJECTS with the real cause
        // (#10618: the handler throws an AppError) — the `await` rethrows it
        // here, before `import()`, so the ErrorBoundary shows why activation
        // failed (e.g. a manifest collision or an activate() throw) instead of
        // the generic import timeout the module load would otherwise produce
        // once its handlers never bound.
        //
        // On a retry after an import-stage failure this also asks main for a
        // replacement URL on a fresh view generation (#11728). The previous
        // specifier is permanently poisoned — the module map never evicts a
        // failed entry — so recovery needs a URL V8 has never seen. Main
        // builds it from the loaded manifest and mints the generation once per
        // plugin load, which caps the module map at two namespaces per plugin
        // however many times the user retries. The first attempt keeps the
        // single-argument call so it stays a pure activation request.
        // Started before activation is awaited so the Tailwind chunk, the
        // ~10ms compile, and the view's own source read all overlap the
        // activation round trip rather than queueing behind it (#12220).
        const initialPath = pluginViewImportPath(recoveryComponentPath ?? componentPath);
        const trackStyles = (path: string): Promise<number> => {
          const stylesStart = performance.now();
          return preparePluginStyles(path).then(() => endPhase("styles", stylesStart));
        };
        const stylesReady = trackStyles(initialPath);
        const kitReady = whenKitReady();
        const activateStart = performance.now();
        let recovered: string | undefined;
        try {
          recovered = requestRecoveryPath
            ? await window.electron?.plugin?.activateForView?.(kindId, true)
            : await window.electron?.plugin?.activateForView?.(kindId);
        } catch (err) {
          forgetActivation();
          throw err;
        }
        rememberActivation(false);
        timing.activateMs = endPhase("activate", activateStart);
        markPluginView(PERF_MARKS.PLUGIN_VIEW_ACTIVATED, { pluginId, kindId });
        if (typeof recovered === "string" && recovered.length > 0) {
          recoveryComponentPath = recovered;
        }
        const viewPath = pluginViewImportPath(recoveryComponentPath ?? componentPath);
        pluginDocumentRuntime.registerView(pluginId, viewPath);
        pluginViewMetrics.registerViewOrigin(pluginId, viewPath);
        try {
          const importStart = performance.now();
          const module: unknown = await import(/* @vite-ignore */ viewPath);
          timing.importMs = endPhase("import", importStart);
          // Awaited AFTER the import, so the two run concurrently, but before
          // the load resolves — which is what makes the view's first paint
          // styled instead of flashing unstyled. `preparePluginStyles` never
          // rejects: a plugin that renders unstyled beats one that will not
          // render, so a styling failure must not reach the error boundary.
          // A recovery generation minted during activation re-prepares under
          // its own URL; it is the same file, so this is all but free.
          // Assigned from the preparation actually awaited, so a recovery's
          // speculative first preparation cannot overwrite the real one.
          const [stylesMs] = await Promise.all([
            viewPath === initialPath ? stylesReady : trackStyles(viewPath),
            kitReady,
          ]);
          timing.stylesMs = stylesMs;
          if (isPluginViewModule(module)) {
            loadedModule = { path: viewPath, view: module.default };
          }
          timing.loadMs = endPhase("view-load", timing.openedAt);
          markPluginView(PERF_MARKS.PLUGIN_VIEW_IMPORTED, { pluginId, kindId });
          return module;
        } catch (err) {
          throw markImportStageFailure(err);
        }
      })(),
      // Counts as an import-stage failure: the losing `import()` keeps
      // running after this rejects (dynamic import has no cancellation),
      // so if it eventually fails it poisons this specifier behind our
      // back. Retrying on a fresh generation sidesteps that entirely,
      // which is why the timeout is safe to leave uncancelled (#11728).
      //
      // Deliberately conservative: a timeout can also mean activation
      // stalled, in which case the specifier was never touched and the
      // extra generation is unnecessary. Harmless — main mints at most one
      // per plugin load either way. The marking is a superset that can only
      // over-recover, never fail.
      () =>
        markImportStageFailure(
          new Error(
            `Plugin "${pluginId}" view module at ${recoveryComponentPath ?? componentPath} timed out after ${PLUGIN_VIEW_IMPORT_TIMEOUT_MS}ms`
          )
        )
    );
    if (!isPluginViewModule(mod)) {
      throw new Error(
        `Plugin "${pluginId}" view module at ${componentPath} did not export a default React component`
      );
    }
    return mod.default;
  };

  /**
   * The view a warm attempt already holds, or null when this attempt has to
   * load first. Warm means the module (or builtin
   * component) is the one already loaded AND the backend that activation
   * reached is still the one running — after an idle dispose, a worker restart
   * or crash, or a reload that republished the kind, the attempt activates
   * before its first render exactly as a cold open does (#10523).
   */
  const warmViewFor = (
    requestRecoveryPath: boolean,
    builtinComponent: ComponentType<PanelViewProps> | null
  ): ComponentType<PanelViewProps> | null => {
    if (requestRecoveryPath || !backendIsLive(builtinComponent !== null)) return null;
    if (builtinComponent) return builtinViews.get(builtinComponent) ?? null;
    const viewPath = pluginViewImportPath(recoveryComponentPath ?? componentPath);
    return loadedModule?.path === viewPath ? loadedModule.view : null;
  };

  /**
   * A warm view still activates before it renders (#10523): the renderer's
   * status can report the previous backend as ready for a moment after a
   * restart or reload, and a view mounted then would run its mount effects
   * against a plugin that has not activated. Main answers at once for an
   * activated plugin, so this costs one IPC round trip, and the call is what
   * stamps the plugin's idle-dispose activity. A rejection reaches the boundary
   * the way a cold open's would.
   */
  const activateWarmView = async (
    view: ComponentType<PanelViewProps>,
    builtin: boolean,
    timing: ViewLoadTiming
  ): Promise<ComponentType<PanelViewProps>> => {
    if (!builtin) {
      const viewPath = pluginViewImportPath(recoveryComponentPath ?? componentPath);
      pluginDocumentRuntime.registerView(pluginId, viewPath);
      pluginViewMetrics.registerViewOrigin(pluginId, viewPath);
    }
    await withLoadTimeout(
      (async () => {
        const activateStart = performance.now();
        try {
          await window.electron?.plugin?.activateForView?.(kindId);
        } catch (err) {
          forgetActivation();
          throw err;
        }
        timing.activateMs = endPhase("activate", activateStart);
        markPluginView(PERF_MARKS.PLUGIN_VIEW_ACTIVATED, { pluginId, kindId });
      })(),
      () =>
        new Error(
          `Plugin "${pluginId}" view activation timed out after ${PLUGIN_VIEW_IMPORT_TIMEOUT_MS}ms`
        )
    );
    timing.loadMs = endPhase("view-load", timing.openedAt);
    markPluginView(PERF_MARKS.PLUGIN_VIEW_IMPORTED, { pluginId, kindId });
    return view;
  };

  /**
   * `retry` marks an attempt that replaces one whose load or render failed, as
   * opposed to a cold open, a user reload of a healthy view, or a backend rebind.
   *
   * Building an attempt has no side effects beyond its timing mark, so it is
   * safe from a state initializer that StrictMode runs twice. The load itself
   * starts from the content's effect through `run`, which is memoized, so a
   * replayed effect shares the one activation and import.
   */
  const createAttempt = (
    requestRecoveryPath: boolean,
    builtinComponent: ComponentType<PanelViewProps> | null,
    retry: boolean
  ): ViewAttempt => {
    const timing = startTiming(retry);
    const warmView = warmViewFor(requestRecoveryPath, builtinComponent);
    let started: Promise<ComponentType<PanelViewProps>> | null = null;
    if (warmView) {
      return {
        timing,
        run: () => (started ??= activateWarmView(warmView, builtinComponent !== null, timing)),
      };
    }
    return {
      timing,
      run: () =>
        (started ??= builtinComponent
          ? loadBuiltinView(builtinComponent, timing)
          : loadModuleView(requestRecoveryPath, timing)),
    };
  };

  /**
   * Schedules the first-frame sample for `timing`, returning its cancel. A
   * factory-scope function rather than inline in the reporter's effect, since
   * it marks the attempt's timing recorded and a component may not mutate what
   * it was handed.
   */
  const scheduleFirstPaintSample = (timing: ViewLoadTiming): (() => void) => {
    if (timing.recorded || typeof requestAnimationFrame !== "function") return () => {};
    const committedAt = performance.now();
    const frame = requestAnimationFrame((frameStart) => {
      if (timing.recorded) return;
      timing.recorded = true;
      // The frame cannot have begun before the commit it paints; the max
      // guards a clock that reports otherwise.
      const paintedAt = Math.max(committedAt, frameStart);
      const firstPaintMs = paintedAt - timing.openedAt;
      measurePluginViewPhase(pluginId, "first-paint", timing.openedAt, paintedAt, { kindId });
      markPluginView(PERF_MARKS.PLUGIN_VIEW_FIRST_PAINT, {
        pluginId,
        kindId,
        retry: timing.retry,
        firstPaintMs: roundMs(firstPaintMs),
      });
      pluginViewMetrics.recordViewLoad(
        pluginId,
        {
          kindId,
          activateMs: roundMs(timing.activateMs),
          importMs: roundMs(timing.importMs),
          stylesMs: roundMs(timing.stylesMs),
          loadMs: roundMs(timing.loadMs),
          firstPaintMs: roundMs(firstPaintMs),
          retry: timing.retry,
          at: Date.now(),
        },
        viewGeneration
      );
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  };

  return { createAttempt, forgetActivation, scheduleFirstPaintSample, onViewCommit };
}

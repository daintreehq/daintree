import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import type { PanelViewProps } from "@shared/types/plugin";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { ErrorFallbackProps } from "@/components/ErrorBoundary/ErrorFallback";
import { Skeleton, SkeletonHint } from "@/components/ui/Skeleton";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import { PluginViewDiagnosticsFallback } from "@/components/Plugin/PluginViewDiagnosticsFallback";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * The resolved subset of `PanelKindConfig` a plugin view actually needs. Both
 * `componentPath` and `extensionId` are non-optional here: the misconfiguration
 * check lives in the caller (`makePluginViewHost`), so everything downstream of
 * it works with proven-present values rather than non-null assertions.
 */
export interface PluginViewContentConfig {
  id: string;
  name: string;
  componentPath: string;
  extensionId: string;
}

/**
 * What a presentation host must supply. Deliberately presentation-neutral — no
 * title, focus, tabs, or close handlers — so a dialog host can mount the same
 * content without inheriting grid-pane chrome (#11240). `initialArgs` mirrors
 * the SDK-facing `PanelViewProps` name rather than the panel-persistence term
 * (`extensionState`) the grid adapter stores it under.
 */
export interface PluginViewContentProps {
  panelId: string;
  initialArgs?: Record<string, unknown>;
}

/**
 * Upper bound on a single `plugin://` view import before the host gives up and
 * surfaces the ErrorBoundary's retry. Generous enough to cover a cold protocol
 * handler start; short enough that a genuinely wedged load doesn't strand the
 * user on an indefinite skeleton (#10512).
 */
const PLUGIN_VIEW_IMPORT_TIMEOUT_MS = 10_000;

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

/**
 * Build the chrome-free half of a plugin panel: activation, lazy `plugin://`
 * import, error boundary, and dispose-signal lifecycle. It still owns the UI
 * those duties imply — the loading skeleton, the fade-in, and the diagnostics
 * fallback — but none of the surrounding panel shell: no header, no focus
 * target, no close control. The presentation host supplies that — `ContentPanel`
 * for grid/dock panes today, a dialog shell later (#11240 / #11239).
 *
 * Call this ONCE per kind, at factory-construction scope — never inside a
 * render. `lazy()` and every piece of state below are keyed to the returned
 * component's identity, so re-invoking the factory while rendering would remount
 * the plugin view (and restart its import) on every parent render. Callers must
 * cache the result per `(kindId, componentPath)`, as `usePluginPanelKinds` does.
 *
 * Lifetime contract:
 *   - On mount the content creates an `AbortController` and passes its signal as
 *     `disposeSignal` to the plugin view.
 *   - The signal aborts when this React subtree unmounts AND when the plugin's
 *     kind disappears from a `plugin:panel-kinds-changed` broadcast (the
 *     broadcast fires before the main process tears down plugin IPC handlers, so
 *     signal-driven cleanup runs while host APIs are still live).
 *   - On render error the boundary's "Try again" button reloads the module — a
 *     fresh state-held ref produces a new `lazy()` call so `import()` is
 *     re-evaluated rather than returning the cached failed promise.
 *
 * `componentPath` is imported verbatim — there is deliberately no cache-busting
 * query string. V8 caches ESM module records by URL and Chromium has no way to
 * evict an entry (Vite #14438 / Chromium #350426234, unresolved as of 2026), so
 * a per-load version parameter would permanently expand the renderer's module
 * map. If dev-mode hot reload ever needs one, gate it on `import.meta.env.DEV`;
 * it must never ship to production.
 */
export function makePluginViewContent(
  config: PluginViewContentConfig
): ComponentType<PluginViewContentProps> {
  const { componentPath, extensionId: pluginId, id: kindId, name: displayName } = config;

  // Defined once per content factory, not inline in render: the boundary swaps
  // its fallback subtree whenever this component *type* changes identity, which
  // would remount the diagnostics pane (and drop its copy feedback) on every
  // render.
  function PluginViewFallback({ error, errorInfo, resetError, incidentId }: ErrorFallbackProps) {
    // Two primitive selectors rather than one object selector: the meta record
    // is rebuilt on every provenance pull, so selecting it whole would re-render
    // the pane on pulls that changed nothing about this plugin.
    const devMode = usePluginRuntimeStore((s) => s.pluginMetaById.get(pluginId)?.devMode === true);
    const pluginDisplayName = usePluginRuntimeStore(
      (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginId
    );

    // Re-pull here rather than at mount, because at mount the plugin may not be
    // listable yet: `loadPlugin` registers the panel kind (which is what mounts
    // this content) before awaiting skill loading and entering the plugins map,
    // and `daintree-plugin dev` never fires provenance at all. Reaching this
    // component means the view rendered and threw, so its plugin is certainly
    // loaded by now and this pull can see it. The pane fails closed meanwhile
    // and upgrades in place when the snapshot lands.
    const refreshPluginRuntime = usePluginRuntimeStore((s) => s.refresh);
    useEffect(() => refreshPluginRuntime(), [refreshPluginRuntime]);

    return (
      <PluginViewDiagnosticsFallback
        error={error}
        errorInfo={errorInfo}
        resetError={resetError}
        incidentId={incidentId}
        pluginId={pluginId}
        pluginDisplayName={pluginDisplayName}
        kindId={kindId}
        panelDisplayName={displayName}
        componentPath={componentPath}
        devMode={devMode}
      />
    );
  }

  const createLazyView = (): LazyExoticComponent<ComponentType<PanelViewProps>> =>
    lazy<ComponentType<PanelViewProps>>(async () => {
      // Race the `plugin://` import against a timeout. A wedged protocol load
      // (handler hang, never-resolving fetch) would otherwise sit behind
      // Suspense forever — the ErrorBoundary only catches rejections, never a
      // pending promise. Rejecting on timeout routes through Suspense to the
      // boundary's "Try again", and because the race lives inside the factory a
      // retry (a fresh `createLazyView()`) restarts the timer cleanly (#10512).
      // The activation + import sequence shares one timeout so a stalled
      // `activate()` surfaces the same recovery path as a stalled import.
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const mod: unknown = await Promise.race([
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
          await window.electron?.plugin?.activateForView?.(kindId);
          return import(/* @vite-ignore */ componentPath);
        })().finally(() => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Plugin "${pluginId}" view module at ${componentPath} timed out after ${PLUGIN_VIEW_IMPORT_TIMEOUT_MS}ms`
              )
            );
          }, PLUGIN_VIEW_IMPORT_TIMEOUT_MS);
        }),
      ]);
      if (!isPluginViewModule(mod)) {
        throw new Error(
          `Plugin "${pluginId}" view module at ${componentPath} did not export a default React component`
        );
      }
      return { default: mod.default };
    });

  function PluginViewContent({ panelId, initialArgs }: PluginViewContentProps) {
    // Store the lazy component in state so retries can swap in a fresh ref
    // without a useMemo dependency array. Each `lazy()` wrapper caches its
    // import result on its own payload, so a chunk-load failure is sticky for
    // that wrapper — recovering requires constructing a genuinely new one, not
    // re-invoking the old one. Using a state initializer (and
    // `setLazyView(() => createLazyView())` on reset) keeps exhaustive-deps
    // happy and lets the React Compiler optimize this component.
    const [LazyView, setLazyView] = useState<LazyExoticComponent<ComponentType<PanelViewProps>>>(
      () => createLazyView()
    );
    // Drive the ErrorBoundary's `resetKeys` independently — the reset
    // counter is observable to the boundary even though the lazy ref lives
    // in its own slot.
    const [retryCount, setRetryCount] = useState(0);

    // Warm the plugin runtime mirror at mount so the dev-mode flag is usually
    // already there if this view later throws. The fallback re-pulls for the
    // cases this can't cover; see PluginViewFallback.
    const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
    useEffect(() => initPluginRuntime(), [initPluginRuntime]);

    // The dispose controller lives in state because its signal is consumed
    // during render (passed to the plugin view as `disposeSignal`), and refs
    // must not be read during render. A retry swaps in a fresh controller via
    // handleReset so the new lazy import sees an unaborted signal.
    const [controller, setController] = useState<AbortController>(() => new AbortController());

    // Mirror the current controller into a ref so the long-lived (deps: [])
    // teardown effect below reads the *latest* controller at call time — i.e.
    // the post-retry one — without having to re-subscribe to the
    // panel-kinds-changed broadcast on every retry.
    const controllerRef = useRef(controller);
    useEffect(() => {
      controllerRef.current = controller;
    }, [controller]);

    useEffect(() => {
      let disposed = false;
      const electron = typeof window !== "undefined" ? window.electron : undefined;
      const onChanged = electron?.plugin?.onPanelKindsChanged;
      let cleanup: (() => void) | undefined;
      if (onChanged) {
        cleanup = onChanged((payload) => {
          if (disposed) return;
          const stillRegistered = payload.kinds.some((k) => k.id === kindId);
          if (!stillRegistered) {
            // Read the controller through the ref so a retry that swapped in a
            // fresh AbortController is the one that gets aborted. Capturing
            // `controllerRef.current` into a const at effect setup would leave
            // post-retry signals permanently un-aborted on plugin removal.
            controllerRef.current?.abort();
          }
        });
      }
      return () => {
        disposed = true;
        cleanup?.();
        controllerRef.current?.abort();
      };
    }, []);

    const handleReset = (): void => {
      // Abort the outgoing view's signal before swapping in a fresh controller —
      // the prior view instance is being discarded on retry, so any fetches or
      // subscriptions it tied to `disposeSignal` must cancel now rather than
      // linger until the whole subtree unmounts (#10512 review).
      controller.abort();
      // Fresh controller for the retry so the new lazy import sees an unaborted
      // signal; the mirror effect propagates it to controllerRef for teardown.
      setController(new AbortController());
      setLazyView(() => createLazyView());
      setRetryCount((c) => c + 1);
    };

    return (
      <ErrorBoundary
        variant="component"
        // `kindId` is already `${pluginId}.${panel.id}` (PluginService builds
        // it that way), so prefixing pluginId again doubled it.
        componentName={`PluginView:${kindId}`}
        fallback={PluginViewFallback}
        onReset={handleReset}
        resetKeys={[retryCount]}
      >
        <Suspense
          fallback={
            // Content-only bones: the presentation host already paints the real
            // header, so a skeleton carrying its own (BrowserPaneSkeleton) would
            // double it. Mirrors DevPreviewPaneFallback's quiet canvas — a
            // plugin's content shape is unknowable, so bones must not imply one.
            <div className="relative h-full">
              <Skeleton label={`Loading ${displayName}`} className="h-full bg-surface-canvas" />
              <SkeletonHint className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto" />
            </div>
          }
        >
          <ContentFadeIn className="flex flex-col flex-1 min-h-0 w-full">
            <LazyView
              panelId={panelId}
              pluginId={pluginId}
              disposeSignal={controller.signal}
              initialArgs={initialArgs}
            />
          </ContentFadeIn>
        </Suspense>
      </ErrorBoundary>
    );
  }

  PluginViewContent.displayName = `PluginViewContent(${kindId})`;
  return PluginViewContent;
}

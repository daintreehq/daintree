import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PanelViewProps } from "@shared/types/plugin";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { ErrorFallbackProps } from "@/components/ErrorBoundary/ErrorFallback";
import { BrowserPaneSkeleton } from "@/components/Browser/BrowserPaneSkeleton";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import { usePanelRootFocus } from "@/components/Panel/usePanelRootFocus";
import { PluginViewDiagnosticsFallback } from "@/components/Plugin/PluginViewDiagnosticsFallback";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import type { PanelComponentProps } from "@/panels/registry";
import { logWarn } from "@/utils/logger";

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
 * Build a per-kind renderer host that lazy-imports the plugin's React module
 * over the `plugin://` protocol and mounts it under an `ErrorBoundary` +
 * `Suspense`. One host instance is created per plugin panel kind during
 * `usePluginPanelKinds` reconciliation — the closure captures the
 * already-resolved `plugin://{pluginId}/{path}` URL stored on the kind's
 * `PanelKindConfig.componentPath`.
 *
 * Lifetime contract:
 *   - On mount the host creates an `AbortController` and passes its signal as
 *     `disposeSignal` to the plugin view.
 *   - The signal aborts when the host React subtree unmounts AND when the
 *     plugin's kind disappears from a `plugin:panel-kinds-changed` broadcast
 *     (the broadcast fires before the main process tears down plugin IPC
 *     handlers, so signal-driven cleanup runs while host APIs are still live).
 *   - On render error the boundary's "Try again" button reloads the module —
 *     a fresh `useMemo` ref produces a new `lazy()` call so `import()` is
 *     re-evaluated rather than returning the cached failed promise.
 *
 * The dev-mode hot-reload mechanism (a versioned query-string) is intentionally
 * scoped to `import.meta.env.DEV`. V8 caches ESM module records by URL string
 * and Chromium has no way to evict an entry (Vite #14438 / Chromium #350426234,
 * unresolved as of 2026), so every dev iteration permanently expands the
 * renderer's module map. Acceptable for dev; never for production.
 */
export function makePluginViewHost(config: PanelKindConfig): ComponentType<PanelComponentProps> {
  const componentPath = config.componentPath;
  const pluginId = config.extensionId;
  const kindId = config.id;
  const displayName = config.name;

  if (!componentPath || !pluginId) {
    // The else-branch of usePluginPanelKinds guards this, but a defensive
    // check here keeps the component contract self-checking — a future caller
    // that bypasses the hook gets an inline warn rather than a confusing
    // runtime error from `import('plugin://undefined')`.
    return function PluginViewHostMisconfigured() {
      return (
        <PluginViewLoadError
          pluginId={pluginId ?? "(unknown)"}
          displayName={displayName}
          message="Plugin view is misconfigured: missing componentPath or pluginId."
        />
      );
    };
  }

  // Defined once per host, not inline in render: the boundary swaps its
  // fallback subtree whenever this component *type* changes identity, which
  // would remount the diagnostics pane (and drop its copy feedback) on every
  // host render.
  function PluginViewFallback({ error, errorInfo, resetError, incidentId }: ErrorFallbackProps) {
    // Two primitive selectors rather than one object selector: the meta record
    // is rebuilt on every provenance pull, so selecting it whole would re-render
    // the pane on pulls that changed nothing about this plugin.
    const devMode = usePluginRuntimeStore((s) => s.pluginMetaById.get(pluginId!)?.devMode === true);
    const pluginDisplayName = usePluginRuntimeStore(
      (s) => s.pluginMetaById.get(pluginId!)?.displayName ?? pluginId!
    );

    return (
      <PluginViewDiagnosticsFallback
        error={error}
        errorInfo={errorInfo}
        resetError={resetError}
        incidentId={incidentId}
        pluginId={pluginId!}
        pluginDisplayName={pluginDisplayName}
        kindId={kindId}
        panelDisplayName={displayName}
        componentPath={componentPath!}
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
          // chaining keeps the host working in test environments without
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
          return import(/* @vite-ignore */ componentPath!);
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

  function PluginViewHost(props: PanelComponentProps) {
    // Store the lazy component in state so retries can swap in a fresh ref
    // without a useMemo dependency array — `lazy()` memoizes the import
    // promise by factory-function identity, so retrying after a chunk-load
    // failure requires a genuinely new factory reference. Using a state
    // initializer (and `setLazyView(() => createLazyView())` on reset) keeps
    // exhaustive-deps happy and lets the React Compiler optimize the host.
    const [LazyView, setLazyView] = useState<LazyExoticComponent<ComponentType<PanelViewProps>>>(
      () => createLazyView()
    );
    // Drive the ErrorBoundary's `resetKeys` independently — the reset
    // counter is observable to the boundary even though the lazy ref lives
    // in its own slot.
    const [retryCount, setRetryCount] = useState(0);

    // Warm the plugin runtime mirror from the host rather than the fallback:
    // the pull is async, and starting it at mount means the dev-mode flag has
    // landed long before a view can resolve and then throw. The fallback still
    // subscribes, so a late snapshot upgrades a redacted trace in place.
    const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
    useEffect(() => initPluginRuntime(), [initPluginRuntime]);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelId = props.id;
    // Focusing the host root establishes ownership in the parent document; it
    // does not push focus into the plugin's guest frame. Focus already inside
    // the host (a plugin input, an iframe) is left where it is.
    const getRootNode = useCallback(() => rootRef.current, []);
    usePanelRootFocus({ id: panelId, isFocused: props.isFocused, getNode: getRootNode });

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
      // linger until the whole host unmounts (#10512 review).
      controller.abort();
      // Fresh controller for the retry so the new lazy import sees an unaborted
      // signal; the mirror effect propagates it to controllerRef for teardown.
      setController(new AbortController());
      setLazyView(() => createLazyView());
      setRetryCount((c) => c + 1);
    };

    return (
      // Plugin views render no ContentPanel, so the host owns the panel's focus
      // target. Sitting outside the boundary keeps macro-grid Enter working
      // while the view is still loading and after it has failed.
      <div ref={rootRef} tabIndex={-1} className="flex flex-col h-full w-full">
        <ErrorBoundary
          variant="component"
          // `kindId` is already `${pluginId}.${panel.id}` (PluginService builds
          // it that way), so prefixing pluginId again doubled it.
          componentName={`PluginView:${kindId}`}
          fallback={PluginViewFallback}
          onReset={handleReset}
          resetKeys={[retryCount]}
        >
          <Suspense fallback={<BrowserPaneSkeleton label={`Loading ${displayName}`} />}>
            <ContentFadeIn className="flex flex-col h-full w-full">
              <LazyView
                panelId={props.id}
                pluginId={pluginId!}
                disposeSignal={controller.signal}
                initialArgs={props.extensionState}
              />
            </ContentFadeIn>
          </Suspense>
        </ErrorBoundary>
      </div>
    );
  }

  PluginViewHost.displayName = `PluginViewHost(${kindId})`;
  return PluginViewHost;
}

interface PluginViewLoadErrorProps {
  pluginId: string;
  displayName: string;
  message: string;
}

function PluginViewLoadError({ pluginId, displayName, message }: PluginViewLoadErrorProps) {
  useEffect(() => {
    logWarn("[PluginViewHost] view configuration error", { pluginId, displayName, message });
  }, [pluginId, displayName, message]);

  return (
    <div
      role="region"
      aria-label="Plugin view unavailable"
      className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-panel p-6 text-text-muted"
    >
      <p className="text-sm font-medium text-text-primary">{displayName} unavailable</p>
      <p className="max-w-sm text-center text-xs text-text-muted">{message}</p>
    </div>
  );
}

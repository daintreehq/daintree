import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import type { PanelViewProps } from "@shared/types/plugin";
import {
  clearViewRenderFailure,
  getPanelRemovedSignal,
  reportViewMounted,
  reportViewRenderFailed,
} from "@/services/plugin/pluginPanelLifecycle";
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
  /**
   * Close this panel, supplied by whichever host is presenting it (#11301).
   * The diagnostics fallback surfaces it as "Close panel" — without it a broken
   * view is a dead end, because `panel.openPluginPanel` defaults to
   * `reuseExisting: true` and re-running the plugin's own open command just
   * refocuses the panel that is already failing.
   *
   * A prop rather than an `actionService.dispatch` from inside the fallback so
   * this stays presentation-neutral: the grid host trashes the panel, while a
   * dialog host dismisses its modal. Omitted means the host offers no close, and
   * the button is not rendered.
   */
  onRequestClose?: () => void;
  /** The worktree owning the panel instance, forwarded to the view as
   * `PanelViewProps.worktreeId` so it can reconstruct its own context (#11297). */
  worktreeId?: string;
  /**
   * Override the panel-removal signal, for a host whose content is NOT a panel
   * record (§7.8 project surfaces).
   *
   * `pluginPanelLifecycle` derives permanent removal from the panel store and
   * aborts the signal of any tracked id the store no longer lists. A surface's
   * synthesized id is never in that store, so the default lookup would report a
   * still-mounted surface as permanently removed on the next panel-store write
   * — tearing down exactly the durable resources this signal exists to outlive.
   * A host that owns its own removal lifetime supplies it here and is never
   * tracked.
   */
  panelRemovedSignal?: AbortSignal;
}

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

function isImportStageFailure(err: unknown): boolean {
  return isWeakKey(err) && importStageFailures.has(err);
}

/**
 * Carries the host's close callback down to the factory-scoped fallback without
 * putting it in the fallback's component identity. Default is an empty object so
 * a content instance mounted without a host (tests, a future embedder) simply
 * renders no close button.
 */
const PluginViewCloseContext = createContext<{ onRequestClose?: () => void }>({});

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
 * Lifetime contract — two signals, because a panel outlives its views (#11301):
 *   - `disposeSignal` is per mount attempt. The content creates an
 *     `AbortController` on mount and aborts it when this subtree unmounts, when
 *     "Try again" swaps in a fresh attempt, and when the plugin's kind
 *     disappears from a `plugin:panel-kinds-changed` broadcast (that broadcast
 *     fires before the main process tears down plugin IPC handlers, so
 *     signal-driven cleanup runs while host APIs are still live). A temporary
 *     unmount — maximizing a sibling pane, leaving a dock tab — aborts it too.
 *   - `panelRemovedSignal` is per panel. It comes from `pluginPanelLifecycle`,
 *     which keys it by `panelId` so every mount of the same panel receives the
 *     same object, and aborts it only when the panel is permanently removed. A
 *     host whose content is not a panel record supplies its own instead — see
 *     {@link PluginViewContentProps.panelRemovedSignal}.
 *   - On render error the boundary's "Try again" button reloads the module — a
 *     fresh state-held ref produces a new `lazy()` call so `import()` is
 *     re-evaluated rather than returning the cached failed promise.
 *
 * `componentPath` is imported as given. It already carries a per-load generation
 * segment minted by `buildPluginViewUrl` in main, which is what makes an
 * upgraded plugin's view actually load: V8 caches ESM module records by URL and
 * Chromium has no way to evict an entry (Vite #14438 / Chromium #350426234,
 * still unresolved), so only a specifier V8 has never seen re-evaluates. Never
 * add a cache-buster HERE — a per-render or per-retry parameter would grow the
 * module map without bound. The one exception is deliberate and still
 * main-minted: after an import-stage failure the retry asks main for a
 * replacement URL on a second generation (#11728), because the failed entry is
 * keyed by specifier and re-importing it can only fail again. Main allocates
 * that generation at most once per plugin load and shares it across the plugin's
 * views, so the bound is two namespaces per load rather than one per retry.
 */
export function makePluginViewContent(
  config: PluginViewContentConfig
): ComponentType<PluginViewContentProps> {
  const { componentPath, extensionId: pluginId, id: kindId, name: displayName } = config;

  // Defined once per content factory, not inline in render: the boundary swaps
  // its fallback subtree whenever this component *type* changes identity, which
  // would remount the diagnostics pane (and drop its copy feedback) on every
  // render. That stability is also why the per-instance close callback arrives
  // through context instead of a prop — a closure over `onRequestClose` would
  // change the component type on every render of the owning panel.
  function PluginViewFallback({ error, errorInfo, resetError, incidentId }: ErrorFallbackProps) {
    const { onRequestClose } = useContext(PluginViewCloseContext);
    // Two primitive selectors rather than one object selector: the meta record
    // is rebuilt on every provenance pull, so selecting it whole would re-render
    // the pane on pulls that changed nothing about this plugin.
    const devMode = usePluginRuntimeStore((s) => s.pluginMetaById.get(pluginId)?.devMode === true);
    const pluginDisplayName = usePluginRuntimeStore(
      (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginId
    );

    // Re-pull here rather than at mount, because at mount the plugin may not be
    // listable yet: `daintree-plugin dev` never fires provenance at all. (Panel
    // kinds are now published after the plugins-map commit, so a kind that
    // mounted this content does at least have a loaded plugin behind it —
    // #11728.) Reaching this component means the view rendered and threw, so
    // this pull can see it. The pane fails closed meanwhile and upgrades in
    // place when the snapshot lands.
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
        onRequestClose={onRequestClose}
      />
    );
  }

  // Replacement specifier for `componentPath` once main has minted one, cached at
  // factory scope so it outlives both the `lazy()` wrapper and the component
  // instance (#11728). A remount that fell back to the poisoned original would
  // undo the recovery, and `usePluginPanelKinds` caches this factory per
  // (kindId, componentPath) — so every panel of this kind shares the one
  // recovery generation, which is exactly the granularity main mints it at.
  let recoveryComponentPath: string | undefined;

  const createLazyView = (
    requestRecoveryPath = false
  ): LazyExoticComponent<ComponentType<PanelViewProps>> =>
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
          //
          // On a retry after an import-stage failure this also asks main for a
          // replacement URL on a fresh view generation (#11728). The previous
          // specifier is permanently poisoned — the module map never evicts a
          // failed entry — so recovery needs a URL V8 has never seen. Main
          // builds it from the loaded manifest and mints the generation once per
          // plugin load, which caps the module map at two namespaces per plugin
          // however many times the user retries. The first attempt keeps the
          // single-argument call so it stays a pure activation request.
          const recovered = requestRecoveryPath
            ? await window.electron?.plugin?.activateForView?.(kindId, true)
            : await window.electron?.plugin?.activateForView?.(kindId);
          if (typeof recovered === "string" && recovered.length > 0) {
            recoveryComponentPath = recovered;
          }
          try {
            return await import(/* @vite-ignore */ recoveryComponentPath ?? componentPath);
          } catch (err) {
            throw markImportStageFailure(err);
          }
        })().finally(() => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            // Counts as an import-stage failure: the losing `import()` keeps
            // running after this rejects (dynamic import has no cancellation),
            // so if it eventually fails it poisons this specifier behind our
            // back. Retrying on a fresh generation sidesteps that entirely,
            // which is why the timeout is safe to leave uncancelled (#11728).
            //
            // Deliberately conservative: a timeout can also mean activation
            // stalled, in which case the specifier was never touched and the
            // extra generation is unnecessary. Harmless — main mints at most one
            // per plugin load either way. Not unit-tested, because driving the
            // real timer needs fake timers around a live `lazy` factory, which
            // leaves an unhandled rejection from the uncancelled loser; the
            // marking is a superset that can only over-recover, never fail.
            reject(
              markImportStageFailure(
                new Error(
                  `Plugin "${pluginId}" view module at ${recoveryComponentPath ?? componentPath} timed out after ${PLUGIN_VIEW_IMPORT_TIMEOUT_MS}ms`
                )
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

  /**
   * Reports "a view is live for this panel" as a commit-time effect. Rendered as
   * a sibling of the resolved view inside the same boundary, so if the view
   * throws during render React unwinds the whole subtree and this effect never
   * runs — which is what keeps `mounted` honest rather than optimistic.
   */
  function PluginViewMountReporter({ panelId }: { panelId: string }) {
    useEffect(
      () => reportViewMounted(panelId, { kindId, pluginId }),
      // `kindId`/`pluginId` are factory-scope constants, not reactive values.
      [panelId]
    );
    return null;
  }

  function PluginViewContent({
    panelId,
    initialArgs,
    onRequestClose,
    worktreeId,
    panelRemovedSignal: panelRemovedSignalOverride,
  }: PluginViewContentProps) {
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

    // Stable for this panel across every remount and retry — the identity IS
    // the contract, so it is read from the lifecycle service rather than held in
    // component state (which dies with the subtree this signal must outlive).
    // A supplied signal short-circuits the lookup entirely: calling
    // `getPanelRemovedSignal` would register this id with the lifecycle service,
    // which is what makes a non-panel host's content get swept as removed.
    const panelRemovedSignal = panelRemovedSignalOverride ?? getPanelRemovedSignal(panelId);

    const closeContextValue = useMemo(() => ({ onRequestClose }), [onRequestClose]);

    // Whether the error the boundary is currently showing came from the module
    // fetch, which is what decides if "Try again" needs a fresh specifier from
    // main or just a remount. A ref because only the reset handler reads it, and
    // re-rendering on it would be pointless churn.
    const lastErrorWasImportStage = useRef(false);

    const handleRenderError = useCallback(
      (error: Error) => {
        lastErrorWasImportStage.current = isImportStageFailure(error);
        reportViewRenderFailed(panelId, { kindId, pluginId });
      },
      [panelId]
    );

    const handleReset = (): void => {
      // Abort the outgoing view's signal before swapping in a fresh controller —
      // the prior view instance is being discarded on retry, so any fetches or
      // subscriptions it tied to `disposeSignal` must cancel now rather than
      // linger until the whole subtree unmounts (#10512 review).
      controller.abort();
      // Fresh controller for the retry so the new lazy import sees an unaborted
      // signal; the mirror effect propagates it to controllerRef for teardown.
      setController(new AbortController());
      // Ask main for a fresh view generation only when the module fetch is what
      // failed (#11728) — a new `lazy()` wrapper alone cannot recover that,
      // because the poisoned entry belongs to the specifier, not the wrapper.
      // Activation failures and render throws still just remount.
      setLazyView(() => createLazyView(lastErrorWasImportStage.current));
      setRetryCount((c) => c + 1);
      // The retry is under way, so the panel is no longer failed — it is loading.
      // Clearing here (rather than waiting for the next commit) keeps a worker
      // from seeing a stale `render-failed` for as long as the import takes.
      clearViewRenderFailure(panelId);
    };

    return (
      // Outside the boundary, not inside: the fallback is rendered BY the
      // boundary, so a provider nested within it would be unmounted exactly when
      // the fallback needs the close callback.
      <PluginViewCloseContext.Provider value={closeContextValue}>
        <ErrorBoundary
          variant="component"
          // `kindId` is already `${pluginId}.${panel.id}` (PluginService builds
          // it that way), so prefixing pluginId again doubled it.
          componentName={`PluginView:${kindId}`}
          fallback={PluginViewFallback}
          onError={handleRenderError}
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
                panelRemovedSignal={panelRemovedSignal}
                initialArgs={initialArgs}
                worktreeId={worktreeId}
              />
              <PluginViewMountReporter panelId={panelId} />
            </ContentFadeIn>
          </Suspense>
        </ErrorBoundary>
      </PluginViewCloseContext.Provider>
    );
  }

  PluginViewContent.displayName = `PluginViewContent(${kindId})`;
  return PluginViewContent;
}

import {
  Profiler,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type {
  PanelMenuItemContribution,
  PanelReloadResult,
  PanelViewProps,
  PluginFileDocument,
  PluginPanelToolbarItemState,
  PluginSettingsViewContext,
  PluginViewHostContext,
  PluginViewHostKind,
} from "@shared/types/plugin";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import {
  admitViewReload,
  clearViewRenderFailure,
  getPanelRemovedSignal,
  isViewReloadBlocked,
  registerUserViewReload,
  reportViewRenderFailed,
  resetViewReloadBudget,
  setViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";
import { registerPanelReloadHandler } from "@/services/plugin/pluginPanelReload";
import { useAuthoredRunningActions } from "@/services/plugin/runningPluginActions";
import { useApplicationNavigation } from "@/hooks/useApplicationNavigation";
import { Package } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ContentFadeIn } from "@/components/ui/ContentFadeIn";
import { cn } from "@/lib/utils";
import { useSkeletonFloor, useSkeletonGate } from "@/hooks/useDeferredLoading";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  usePluginRuntimeStatus,
  usePluginRuntimeStatusStore,
} from "@/store/pluginRuntimeStatusStore";
import { PluginViewRuntimeStatus } from "@/components/Plugin/PluginViewRuntimeStatus";
import { presentWorkerStatus, useWorkerStall } from "@/components/Plugin/pluginWorkerPresentation";
import {
  pluginStyleRootPropsFor,
  registerPluginStyleRoot,
} from "@/services/plugin/pluginStyleContract";
import { useBuiltinPanelView } from "@/registry/builtinRendererRegistry";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { actionService } from "@/services/ActionService";
import { pluginViewMetrics } from "@/services/plugin/pluginViewMetrics";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import { PluginKitViewHostContext } from "@/components/PluginKit/kitViewHost";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { usePluginPanelToolbarStore } from "@/store/pluginPanelToolbarStore";
import { usePluginPanelMenuStore } from "@/store/pluginPanelMenuStore";
import {
  readDeliveredOpenRequestSeq,
  usePanelOpenRequest,
} from "@/store/pluginPanelOpenRequestStore";
import { normalizePanelMenuItems } from "@shared/utils/pluginPanelMenuItems";
import { normalizePluginPanelTitle } from "@shared/utils/pluginPanelTitle";
import { logWarn } from "@/utils/logger";
import {
  createPluginViewLoader,
  isImportStageFailure,
  type SettledAttempt,
  type ViewAttempt,
} from "./pluginViewLoader";
import {
  PluginViewCloseContext,
  PluginViewLoadFailure,
  PluginViewLoadingSkeleton,
  PluginViewMountReporter,
  PluginViewPaintReporter,
  PluginViewSuspendedFallback,
  createPluginViewFallback,
} from "./PluginViewFallbacks";
import { usePluginViewRebind } from "./usePluginViewRebind";

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
  /**
   * The id names no registered panel kind — a view hosted outside the panel
   * grid (`PluginHostedView`). Such a view is not torn down by
   * `plugin:panel-kinds-changed` (its id is never in that snapshot, so every
   * broadcast would read as removal); its host retires it when the plugin goes
   * away instead.
   */
  standalone?: boolean;
}

/**
 * One frozen context per host kind, so a view receives the same object on
 * every render and a memo keyed on it never churns.
 */
const HOST_CONTEXTS: Readonly<Record<PluginViewHostKind, PluginViewHostContext>> = {
  panel: Object.freeze({ kind: "panel" }),
  surface: Object.freeze({ kind: "surface" }),
  settings: Object.freeze({ kind: "settings" }),
  fileEditor: Object.freeze({ kind: "fileEditor" }),
  sidebar: Object.freeze({ kind: "sidebar" }),
  popover: Object.freeze({ kind: "popover" }),
};

/** The stable {@link PanelViewProps.hostContext} for a host kind. */
export function pluginViewHostContext(kind: PluginViewHostKind): PluginViewHostContext {
  return HOST_CONTEXTS[kind];
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
   * Which version of the plugin's declared state schema `initialArgs` holds,
   * forwarded to the view as `PanelViewProps.stateVersion` so it can migrate an
   * older bag forward (#12280). Absent when the plugin declares no
   * `stateVersion`; the host resolves the value and never passes one the view
   * is not equipped to read.
   */
  stateVersion?: number;
  /**
   * Writes back into the same `extensionState` bag `initialArgs` was read
   * from, so the next mount of this panel restores what the view had. Supplied
   * by the host rather than reached for by the view: a plugin bundle cannot
   * import the panel store, and should not learn how panel persistence works.
   */
  persistState?: (patch: Record<string, unknown>) => boolean;
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
  /**
   * What the recovery button that calls `onRequestClose` says. Defaults to the
   * panel wording; a host whose recovery is not closing a panel names its own
   * (the sidebar's is "Show worktrees").
   */
  requestCloseLabel?: string;
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
  /**
   * The panel's CURRENT accepted state, re-read at the moment recovery starts
   * (#12278).
   *
   * `initialArgs` is frozen at first render on purpose — within one mount the
   * view owns its state, and a live prop would hand any view that persists
   * derived state a render loop. But a recovery is a *new* attempt, and
   * restoring the bag the panel was opened with would silently discard
   * everything the view persisted since. A host backed by a panel record
   * supplies this so recovery restores the latest accepted state; one without a
   * record (project surfaces) omits it and recovery reuses the mount snapshot.
   *
   * "Accepted" is the honest word: `persistState` admits a patch into a
   * debounced save path, so this is what the store holds, not what reached disk
   * — which is why nothing in the recovery UI promises the user a saved panel.
   */
  readRecoveryState?: () => { state?: Record<string, unknown>; version?: number } | null;
  /**
   * Hand the view `requestReload` (#12609) and `setHasUnsavedChanges`, and
   * accept the user's reload (#12611). Opt-in because the loop guard that
   * polices it lives on the panel's lifecycle record, so only a host presenting
   * a real panel — grid, dock, or dialog — can offer it. Project surfaces don't.
   */
  offerRequestReload?: boolean;
  /**
   * Hand the view `setHasUnsavedChanges` without `requestReload`, for a host
   * outside the grid (#14095). The flag needs no panel record — it lives in the
   * lifecycle service under this mount's id, and automatic Sleep and eviction
   * read it — so every host can offer it. Defaults to `offerRequestReload`.
   */
  offerUnsavedChanges?: boolean;
  /**
   * Hand the view `setToolbarItemState` and `setMenuItems`, for a host that
   * draws the panel's header and menus, and with them the kind's manifest
   * `toolbar` and `menu`. Project surfaces don't.
   */
  offerToolbar?: boolean;
  /**
   * Writes a title onto this panel's record, for a host that has one (grid,
   * dock, dialog). The content hands the view `setTitle` only when it is
   * supplied, vetted and bound to the current attempt. Project surfaces and
   * settings views have no panel to name, so they leave it out.
   */
  setPanelTitle?: (title: string) => void;
  /** Forwarded as `PanelViewProps.settingsContext`, for a settings view's host only. */
  settingsContext?: PluginSettingsViewContext;
  /** Forwarded as `PanelViewProps.fileDocument`, for a file editor's host only (#13809). */
  fileDocument?: PluginFileDocument;
  /**
   * Forwarded as `PanelViewProps.hostContext`. Panel hosts leave it unset and
   * get `"panel"`; a host outside the grid passes its own kind.
   */
  hostContext?: PluginViewHostContext;
}

/**
 * Build the chrome-free half of a plugin panel: activation, the `plugin://`
 * import, error boundary, and dispose-signal lifecycle. It still owns the UI
 * those duties imply — the loading skeleton, the fade-in, and the diagnostics
 * fallback — but none of the surrounding panel shell: no header, no focus
 * target, no close control. The presentation host supplies that — `ContentPanel`
 * for grid/dock panes today, a dialog shell later (#11240 / #11239).
 *
 * Call this ONCE per kind, at factory-construction scope — never inside a
 * render. The loaded-module cache and every piece of state below are keyed to the returned
 * component's identity, so re-invoking the factory while rendering would remount
 * the plugin view (and restart its import) on every parent render. Callers must
 * cache the result per `(kindId, componentPath)`, as `usePluginPanelKinds` does.
 *
 * Lifetime contract — two signals, because a panel outlives its views (#11301):
 *   - `disposeSignal` is per mount attempt. The content creates an
 *     `AbortController` on mount and aborts it when this subtree unmounts (a
 *     microtask later, so a StrictMode effect replay can call it off), when
 *     "Try again" or an accepted `requestReload` swaps in a fresh attempt, and
 *     when the plugin's kind disappears from a `plugin:panel-kinds-changed`
 *     broadcast (main sends that from a microtask after `unloadPlugin` has
 *     already removed the plugin's IPC handlers and disposed its worker, so
 *     signal-driven cleanup must tolerate host calls rejecting). A temporary
 *     unmount — maximizing a sibling pane, leaving a dock tab — aborts it too.
 *   - `panelRemovedSignal` is per panel. It comes from `pluginPanelLifecycle`,
 *     which keys it by `panelId` so every mount of the same panel receives the
 *     same object, and aborts it only when the panel is permanently removed. A
 *     host whose content is not a panel record supplies its own instead — see
 *     {@link PluginViewContentProps.panelRemovedSignal}.
 *   - On render error the boundary's "Try again" button reloads the module — a
 *     fresh state-held attempt runs its own load, so `import()` is
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
  const {
    componentPath,
    extensionId: pluginId,
    id: kindId,
    name: displayName,
    standalone = false,
  } = config;
  // Tagged with the owner so a portal the view spreads these onto can be
  // traced back to this plugin (Styles check, long-frame input attribution).
  const styleRootProps = pluginStyleRootPropsFor(pluginId);

  const { createAttempt, forgetActivation, scheduleFirstPaintSample, onViewCommit } =
    createPluginViewLoader({ componentPath, pluginId, kindId });
  const PluginViewFallback = createPluginViewFallback({
    pluginId,
    kindId,
    displayName,
    componentPath,
  });

  function PluginViewContent({
    panelId,
    initialArgs,
    stateVersion,
    persistState,
    onRequestClose,
    requestCloseLabel,
    worktreeId,
    panelRemovedSignal: panelRemovedSignalOverride,
    readRecoveryState,
    offerRequestReload = false,
    offerUnsavedChanges = offerRequestReload,
    offerToolbar = false,
    setPanelTitle,
    settingsContext,
    fileDocument,
    hostContext = HOST_CONTEXTS.panel,
  }: PluginViewContentProps) {
    // Resolved before any attempt is built so the first attempt already takes
    // the right path. Reactive, because a slot registered after this panel
    // mounted must still take over — see the rebind effect below.
    const builtinResolution = useBuiltinPanelView(kindId, pluginId);
    const builtinComponent =
      builtinResolution.status === "ready" ? builtinResolution.component : null;
    const builtinDisabled = builtinResolution.status === "disabled";
    // Read by `replaceAttempt`, which runs from effects and handlers, so a retry
    // builds its attempt for the path currently resolved rather than the one
    // captured when the callback was created.
    const builtinComponentRef = useRef(builtinComponent);
    useEffect(() => {
      builtinComponentRef.current = builtinComponent;
    }, [builtinComponent]);

    // Frozen at the first render of this mount rather than forwarded live.
    // `extensionState` reaches this component straight off the panel record, so
    // once a view can WRITE that record through `persistState` the prop would
    // otherwise change underneath it on every save — turning a documented
    // "arguments you were opened with" snapshot into a live channel, and
    // handing any view that persists state derived from `initialArgs` a render
    // loop. The bag exists to restore a view on its NEXT mount; within one
    // mount the view owns its state.
    // Replaced only by `replaceAttempt` — a recovery is a new attempt, not the
    // same mount, so re-reading the latest accepted state there does not reopen
    // the live-prop hazard this freeze exists to close.
    const [mountArgs, setMountArgs] = useState(() => initialArgs);
    // Frozen with the bag it describes: a live version against a frozen bag
    // would tell the view its state had migrated when what it holds has not.
    const [mountStateVersion, setMountStateVersion] = useState(() => stateVersion);
    // Open requests from reusing opens (#13779) are live, unlike `mountArgs`:
    // they never come from the view's own writes, so they can't loop. What is
    // frozen per attempt is the baseline — the newest request an earlier
    // attempt already rendered. Anything newer is this attempt's to show;
    // anything at or below it was delivered before, and replaying it on a
    // remount would undo whatever the user did since.
    const [openRequestBaseline, setOpenRequestBaseline] = useState(() =>
      readDeliveredOpenRequestSeq(panelId)
    );
    const latestOpenRequest = usePanelOpenRequest(panelId);
    const openRequest =
      latestOpenRequest !== undefined && latestOpenRequest.seq > openRequestBaseline
        ? latestOpenRequest
        : undefined;
    // The current mount attempt, in state so a retry swaps in a fresh one
    // without a useMemo dependency array. A failed load is sticky for its
    // attempt — recovering requires a genuinely new one, never re-running the
    // old one — and the state initializer keeps exhaustive-deps happy and lets
    // the React Compiler optimize this component.
    const [attempt, setAttempt] = useState<ViewAttempt>(() =>
      createAttempt(false, builtinComponent, false)
    );
    // What the current attempt's load settled to. Tagged with its attempt, so
    // a result that lands after a replacement is simply never read.
    const [settled, setSettled] = useState<SettledAttempt | null>(null);
    // Which path the held attempt was built for. Between a resolution change and
    // the effect that replaces the attempt there is one render where the two
    // disagree; rendering the stale attempt then would start a `plugin://`
    // import for a builtin (or mount a builtin for a kind that lost its slot).
    const [attemptBuiltin, setAttemptBuiltin] = useState(() => builtinComponent);
    // Drive the ErrorBoundary's `resetKeys` independently — the reset
    // counter is observable to the boundary even though the attempt lives
    // in its own slot.
    const [retryCount, setRetryCount] = useState(0);
    /**
     * The attempt that is current right now, which `retryCount` only catches up
     * to on the next render. Advanced synchronously wherever an attempt is
     * retired, so a view's `requestReload` can tell it has been superseded even
     * before the replacement commits (#12609).
     */
    const attemptRef = useRef(0);
    /**
     * The last attempt whose view actually committed. Behind `attemptRef` while
     * a replacement is still loading, which is how a backend reload landing in
     * that window learns a fresh view is already on its way (#12610).
     */
    const committedAttemptRef = useRef(-1);
    const markAttemptCommitted = useCallback((attempt: number) => {
      committedAttemptRef.current = attempt;
    }, []);
    /**
     * Identifies the current attempt to the lifecycle service's unsaved-work
     * flag (#12611). Replaced whenever an attempt is retired, so a flag raised
     * by an outgoing view is lowered by its own token and nothing else's.
     */
    const unsavedOwnerRef = useRef<object>({});
    // Read once per mount from the lifecycle service, which is where the block
    // lives: a panel stopped for reloading too often stays stopped across a
    // sibling maximize or a dock-tab switch.
    const [reloadBlocked, setReloadBlocked] = useState(
      () => offerRequestReload && isViewReloadBlocked(panelId)
    );

    // Warm the plugin runtime mirror at mount so the dev-mode flag is usually
    // already there if this view later throws. The fallback re-pulls for the
    // cases this can't cover; see PluginViewFallback.
    const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
    useEffect(() => initPluginRuntime(), [initPluginRuntime]);

    // Long frames are only attributed while a plugin view is mounted, so the
    // monitor costs nothing once the last one closes.
    useEffect(() => pluginViewMetrics.retainView(pluginId), []);

    // The dispose controller lives in state because its signal is consumed
    // during render (passed to the plugin view as `disposeSignal`), and refs
    // must not be read during render. A retry swaps in a fresh controller via
    // handleReset so the new attempt's view sees an unaborted signal.
    const [controller, setController] = useState<AbortController>(() => new AbortController());

    // Mirror the current controller into a ref so the long-lived (deps: [])
    // teardown effect below reads the *latest* controller at call time — i.e.
    // the post-retry one — without having to re-subscribe to the
    // panel-kinds-changed broadcast on every retry.
    const controllerRef = useRef(controller);
    useEffect(() => {
      controllerRef.current = controller;
    }, [controller]);

    // The abort a teardown has queued but not yet run. See the effect below.
    const pendingDisposal = useRef<{ cancelled: boolean } | null>(null);

    useEffect(() => {
      // StrictMode replays this effect on mount, running the cleanup and then
      // this setup back to back in one commit. Aborting inside the cleanup
      // handed every view an already-aborted `disposeSignal` on its first mount
      // in development (1db069bf4d). The cleanup now defers the abort by a
      // microtask and a replayed setup calls it off here; a real unmount never
      // re-runs setup, so its abort still lands.
      if (pendingDisposal.current) {
        pendingDisposal.current.cancelled = true;
        pendingDisposal.current = null;
      }
      let disposed = false;
      const electron = typeof window !== "undefined" ? window.electron : undefined;
      const onChanged = standalone ? undefined : electron?.plugin?.onPanelKindsChanged;
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
            forgetActivation();
          }
        });
      }
      return () => {
        disposed = true;
        cleanup?.();
        // Captured now: the microtask must abort the attempt that was live at
        // teardown, never whichever one happens to be current when it runs.
        const outgoing = controllerRef.current;
        const disposal = { cancelled: false };
        pendingDisposal.current = disposal;
        queueMicrotask(() => {
          if (!disposal.cancelled) outgoing.abort();
        });
      };
    }, []);

    // Stable for this panel across every remount and retry — the identity IS
    // the contract, so it is read from the lifecycle service rather than held in
    // component state (which dies with the subtree this signal must outlive).
    // A supplied signal short-circuits the lookup entirely: calling
    // `getPanelRemovedSignal` would register this id with the lifecycle service,
    // which is what makes a non-panel host's content get swept as removed.
    const panelRemovedSignal = panelRemovedSignalOverride ?? getPanelRemovedSignal(panelId);

    const closeContextValue = useMemo(
      () => ({ onRequestClose, requestCloseLabel }),
      [onRequestClose, requestCloseLabel]
    );

    // Whether the error the boundary is currently showing came from the module
    // fetch, which is what decides if "Try again" needs a fresh specifier from
    // main or just a remount. A ref because only the reset handler reads it, and
    // re-rendering on it would be pointless churn.
    const lastErrorWasImportStage = useRef(false);

    // A callback ref rather than an effect: this element lives INSIDE the
    // Suspense boundary, so on the first render it does not exist yet and a
    // mount effect on the parent would only ever see null. React 19 calls this
    // when the node commits and invokes the returned cleanup when it unmounts,
    // which is exactly the lifetime the observer registration wants — and it
    // rides the existing mount/retry cycle rather than adding a second one.
    const contentNodeRef = useRef<HTMLDivElement | null>(null);
    const styleRootRef = useCallback((node: HTMLDivElement | null) => {
      contentNodeRef.current = node;
      const unregister = registerPluginStyleRoot(node);
      // Cleared in the cleanup, not by a `null` call: React 19 invokes a
      // callback ref's returned cleanup INSTEAD of re-calling it with null, so
      // without this the ref would pin a detached subtree until the next mount.
      return () => {
        contentNodeRef.current = null;
        unregister();
      };
    }, []);
    // What the kit's hooks read about this view: the bag `usePersistentViewState`
    // restores from and writes through, and the root view-scoped keys listen in.
    const kitViewHost = useMemo(
      () => ({
        initialArgs: mountArgs,
        persistState,
        root: contentNodeRef,
        keyEvents: new WeakSet<Event>(),
      }),
      [mountArgs, persistState]
    );
    /** Focus lands here when the content it was inside goes inert. */
    const statusRef = useRef<HTMLDivElement | null>(null);
    /** Whether focus is currently somewhere inside the plugin's own content. */
    const focusWasInsideContent = useRef(false);
    /**
     * Whether focus belongs to the plugin's content, including content that has
     * just gone away. The flag can outlive the node it describes, since
     * removing a focused element fires no blur, so it is trusted only while
     * focus is still stranded on the body: focus the user has since put
     * elsewhere is theirs to keep.
     */
    const focusIsInContent = useCallback((): boolean => {
      const content = contentNodeRef.current;
      const active = document.activeElement;
      const stranded = !active || active === document.body;
      return (
        (!!content && !!active && content.contains(active)) ||
        (focusWasInsideContent.current && stranded)
      );
    }, []);

    /** Lower the outgoing attempt's unsaved-work flag and mint the next token. */
    const retireUnsavedOwner = useCallback((): void => {
      setViewUnsavedChanges(panelId, unsavedOwnerRef.current, false);
      unsavedOwnerRef.current = {};
    }, [panelId]);

    /**
     * Reset the header buttons when the view that set them is discarded. Not
     * on unmount: their state belongs to the panel, and a view remounted by a
     * dock or tab move picks up where it left off.
     */
    const clearToolbarState = useCallback((): void => {
      if (!offerToolbar) return;
      usePluginPanelToolbarStore.getState().clearPanel(panelId);
      usePluginPanelMenuStore.getState().setViewItems(panelId, []);
    }, [offerToolbar, panelId]);

    /**
     * Whether the boundary is currently showing its fallback.
     *
     * Tracked here because the boundary does not expose it, and the rebind path
     * below has to know: `ErrorBoundary.componentDidUpdate` calls `onReset`
     * whenever `resetKeys` change WHILE it is showing an error, and `retryCount`
     * is that key.
     */
    const boundaryShowingError = useRef(false);

    const handleRenderError = useCallback(
      (error: Error) => {
        boundaryShowingError.current = true;
        lastErrorWasImportStage.current = isImportStageFailure(error);
        // The boundary has thrown the view away, so whatever it said it held
        // went with it, and the setter it kept must not raise the flag again
        // (#12611). Retired before the abort so no abort listener sees it live.
        attemptRef.current += 1;
        retireUnsavedOwner();
        clearToolbarState();
        // Abort BEFORE reporting, and for the same reason `handleReset` does it
        // on retry: the thrown-away view instance is finished either way, so
        // anything it tied to `disposeSignal` has to cancel now rather than keep
        // fetching and subscribing until the user happens to click Try again or
        // Close. Read through the ref so a post-retry controller is the one that
        // gets aborted (#12278).
        controllerRef.current?.abort();
        reportViewRenderFailed(panelId, { kindId, pluginId });
      },
      [panelId, retireUnsavedOwner, clearToolbarState]
    );

    /**
     * Discard the current mount attempt and start a fresh one.
     *
     * The single path for both recoveries, because they need identical
     * machinery and differ only in what triggers them: the user retrying a view
     * that threw, and a restarted backend the view has to rebind to. Keeping
     * them as one function is what stops the two from drifting into subtly
     * different teardown.
     */
    const replaceAttempt = useCallback(
      (requestRecoveryPath: boolean): void => {
        // Retire the outgoing attempt before aborting its signal: an abort
        // listener that calls back into `requestReload` must already find its
        // attempt stale.
        attemptRef.current += 1;
        retireUnsavedOwner();
        // Header buttons describe the view that set them; a fresh view starts
        // them at rest and says again what it knows.
        clearToolbarState();
        const replacesFailure = boundaryShowingError.current;
        // The attempt being built is new, so whatever the last one threw is no
        // longer on screen once it commits, and whatever focus the last one held
        // went with its DOM.
        boundaryShowingError.current = false;
        focusWasInsideContent.current = false;
        // Abort the outgoing view's signal before swapping in a fresh controller
        // — the prior view instance is being discarded, so any fetches or
        // subscriptions it tied to `disposeSignal` must cancel now rather than
        // linger until the whole subtree unmounts (#10512 review). Read through
        // the ref so the CURRENT controller is the one aborted even when a prior
        // attempt already swapped it.
        controllerRef.current?.abort();
        // Fresh controller for the retry so the new attempt's view sees an
        // unaborted signal. The ref is assigned here rather than left to the
        // mirror effect: a replacement that throws in its first render reaches
        // `handleRenderError` before any passive effect runs, and that abort
        // must land on this attempt's signal, not the one already aborted.
        const next = new AbortController();
        controllerRef.current = next;
        setController(next);
        // Restore what the panel most recently persisted rather than the bag it
        // was opened with — recovery is not supposed to cost the user their
        // work. Absent for hosts with no panel record, which keep the mount
        // snapshot.
        const recovered = readRecoveryState?.();
        if (recovered) {
          setMountArgs(recovered.state);
          setMountStateVersion(recovered.version);
        }
        // A request the outgoing attempt rendered is delivered; one it never
        // got to render is still waiting for this one.
        setOpenRequestBaseline(readDeliveredOpenRequestSeq(panelId));
        // Ask main for a fresh view generation only when the module fetch is
        // what failed (#11728) — a new attempt alone cannot recover
        // that, because the poisoned entry belongs to the specifier, not the
        // wrapper. Activation failures and render throws still just remount.
        const builtin = builtinComponentRef.current;
        setAttempt(createAttempt(requestRecoveryPath, builtin, replacesFailure));
        setAttemptBuiltin(() => builtin);
        setRetryCount(attemptRef.current);
        // The retry is under way, so the panel is no longer failed — it is
        // loading. Clearing here (rather than waiting for the next commit) keeps
        // a worker from seeing a stale `render-failed` for as long as the import
        // takes.
        clearViewRenderFailure(panelId);
      },
      [panelId, readRecoveryState, retireUnsavedOwner, clearToolbarState]
    );

    const handleReset = (): void => {
      // "Try again" is the user reloading the panel, so it starts the reload
      // budget over as well (#12609).
      resetViewReloadBudget(panelId);
      replaceAttempt(lastErrorWasImportStage.current);
    };

    // The user's own reload, and the only thing that lifts a reload block:
    // neither time nor a backend restart does (#12609). Focus that was inside
    // the content it discards comes back to the host rather than dropping to
    // the body; focus anywhere else stays where the user put it (#12611).
    const handleReloadPanel = useCallback(() => {
      const hadFocus = focusIsInContent();
      resetViewReloadBudget(panelId);
      setReloadBlocked(false);
      replaceAttempt(false);
      if (hadFocus) {
        focusWasInsideContent.current = false;
        statusRef.current?.focus({ preventScroll: true });
      }
    }, [focusIsInContent, panelId, replaceAttempt]);

    // Warm the runtime-health mirror at mount. Idempotent and module-level, so
    // every panel of every plugin shares one subscription and one hydration.
    const initRuntimeStatus = usePluginRuntimeStatusStore((s) => s.init);
    useEffect(() => initRuntimeStatus(), [initRuntimeStatus]);
    const worker = usePluginRuntimeStatus(pluginId)?.worker ?? null;
    const inFlight = worker?.state === "starting" || worker?.state === "activating";
    // Only a transient state can stall. A `ready` or `failed` worker is settled,
    // and arming a timer on it would escalate a healthy panel after 30 seconds.
    const stalled = useWorkerStall(inFlight ? worker.stateSince : null);
    // Latched, never lowered: once this panel has had a working backend, a
    // transient state is a recovery rather than a first load, and stays one even
    // if the backend never comes back.
    const [everReady, setEverReady] = useState(false);
    useEffect(() => {
      if (worker?.state === "ready") setEverReady(true);
    }, [worker?.state]);
    const [restarting, setRestarting] = useState(false);
    // Guards work that lands after the render that started it — a restart's
    // settle, a queued reload — so a panel closed in between never sets state
    // on a subtree React has already torn down.
    const aliveRef = useRef(true);
    useEffect(() => {
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
      };
    }, []);
    const handleRestartPlugin = useCallback(() => {
      const restart = window.electron?.plugin?.restartWorker;
      if (typeof restart !== "function") return;
      setRestarting(true);
      void restart(pluginId)
        .catch(() => {
          // The banner is driven by the pushed status, not by this call's
          // outcome: a restart that ran and failed again republishes `failed`,
          // which is the state the user needs to see either way.
        })
        .finally(() => {
          if (aliveRef.current) setRestarting(false);
        });
      // `pluginId` is a factory-scope constant, not a reactive value.
    }, []);

    // `restarting` joins `everReady` in the gate because the two answer the same
    // question — is this a recovery or a first load. On a panel whose INITIAL
    // activation failed, `everReady` is false forever, so without this the
    // `starting` the restart publishes would fall through to `kind: "content"`:
    // the banner would unmount mid-restart, taking the button's own pending
    // state with it, and `contentInert` would lift and re-arm the dead
    // backend's stale controls for the whole round trip.
    const presentation = presentWorkerStatus(worker, stalled, everReady || restarting);

    const boundWorkerGeneration = usePluginViewRebind({
      builtinComponent,
      builtinDisabled,
      worker,
      replaceAttempt,
      boundaryShowingError,
      lastErrorWasImportStage,
    });

    /**
     * A plugin-initiated reload request, bound to the attempt it targets —
     * from the view's own `requestReload` (#12609) or from its backend through
     * `host.reloadPanel` (#12610), which passes `settle` to learn the outcome.
     *
     * Plugin-initiated, so it is the one replacement that is rationed: user
     * retries and backend rebinds call `replaceAttempt` directly and are never
     * charged, while this one passes the panel's budget first. Both sources
     * share that one budget.
     */
    const requestReloadFor = useCallback(
      (attempt: number, settle?: (result: PanelReloadResult) => void): void => {
        // Stale the moment its attempt is retired — including by a replacement
        // still waiting to commit — so a callback that outlived its view can
        // never reload the view that replaced it.
        if (attempt !== attemptRef.current) {
          settle?.("unavailable");
          return;
        }
        // Never acted on inline. A view may call this while rendering, where
        // setting this component's state or aborting a signal is illegal. The
        // deferral is also what merges a burst: the first queued request to act
        // retires the attempt, and the rest find it stale.
        queueMicrotask(() => {
          if (!aliveRef.current) {
            settle?.("unavailable");
            return;
          }
          if (attempt !== attemptRef.current) {
            // Merged into a request that already acted on this attempt: a fresh
            // one is on its way unless that request is what tripped the block.
            settle?.(isViewReloadBlocked(panelId) ? "rate-limited" : "scheduled");
            return;
          }
          // A failed view recovers through the user's Try again, not through a
          // timer the dead attempt left running.
          if (boundaryShowingError.current) {
            settle?.("unavailable");
            return;
          }
          // A backend that is restarting, or already replaced but not yet
          // rebound, owns this panel's next attempt: the rebind it ends in
          // replaces the view anyway. Reloading first would spend the budget on
          // an attempt that is about to be thrown away.
          const bound = boundWorkerGeneration.current;
          const live = usePluginRuntimeStatusStore.getState().statusById.get(pluginId)?.worker;
          if (bound !== null && live && (live.state !== "ready" || live.generation !== bound)) {
            settle?.("unavailable");
            return;
          }
          // A backend request while this attempt is still loading: the view it
          // wants gone never mounted, and the one loading is already fresh.
          // Charging for it would spend the budget on nothing.
          if (settle && committedAttemptRef.current !== attempt) {
            settle(isViewReloadBlocked(panelId) ? "rate-limited" : "scheduled");
            return;
          }
          const admission = admitViewReload(panelId);
          if (admission === "refused") {
            settle?.("unavailable");
            return;
          }
          if (admission === "blocked") {
            // Discard the view it asked to discard, but mount nothing in its
            // place: retire the attempt so nothing it still holds can act, and
            // leave the next one to the user.
            attemptRef.current += 1;
            retireUnsavedOwner();
            clearToolbarState();
            controllerRef.current.abort();
            setReloadBlocked(true);
            settle?.("rate-limited");
            return;
          }
          replaceAttempt(false);
          settle?.("scheduled");
        });
      },
      // `pluginId` is a factory-scope constant, not a reactive value.
      [panelId, replaceAttempt, retireUnsavedOwner, clearToolbarState]
    );

    // One callback per attempt, so a view can safely list it as a dependency.
    const requestReload = useMemo(
      () => (offerRequestReload ? () => requestReloadFor(retryCount) : undefined),
      [offerRequestReload, requestReloadFor, retryCount]
    );

    // The backend's way in (#12610): only where the view itself is offered
    // reloads, so a host that opted out of `requestReload` is not reloadable
    // from the worker either. Always aimed at the attempt current when the
    // request lands, never the one current when this effect ran.
    useEffect(() => {
      if (!offerRequestReload || builtinDisabled) return;
      return registerPanelReloadHandler(
        panelId,
        () =>
          new Promise<PanelReloadResult>((resolve) => {
            requestReloadFor(attemptRef.current, resolve);
          })
      );
    }, [offerRequestReload, builtinDisabled, panelId, requestReloadFor]);

    /**
     * A view's unsaved-work report, bound to the attempt that made it (#12611).
     * Only the attempt that is current may raise or lower the flag, and it does
     * so under its own token, so a setter held past its view cannot clear what
     * the replacement raised. Not gated on `aliveRef`: a StrictMode replay runs
     * the view's effects before this host's, so a view re-reporting from its
     * mount effect would find the host still marked dead.
     */
    const setHasUnsavedChangesFor = useCallback(
      (attempt: number, hasUnsavedChanges: boolean): void => {
        if (attempt !== attemptRef.current) return;
        setViewUnsavedChanges(panelId, unsavedOwnerRef.current, hasUnsavedChanges === true);
      },
      [panelId]
    );
    const setHasUnsavedChanges = useMemo(
      () =>
        offerUnsavedChanges
          ? (hasUnsavedChanges: boolean) => setHasUnsavedChangesFor(retryCount, hasUnsavedChanges)
          : undefined,
      [offerUnsavedChanges, setHasUnsavedChangesFor, retryCount]
    );

    /**
     * A view's header-button state, bound to the attempt that set it like
     * `setHasUnsavedChanges`, so a refresh that settles after a reload cannot
     * repaint the fresh view's buttons. Keyed by the manifest's own `actionId`,
     * and an id the kind's toolbar does not list is dropped.
     */
    /**
     * Set the moment this mount's teardown runs, before the attempt is retired
     * in a microtask: `disposeSignal` aborts in between, and a listener writing
     * state there would otherwise recreate what closing the panel just pruned.
     */
    const toolbarClosedRef = useRef(false);
    useEffect(() => {
      toolbarClosedRef.current = false;
      return () => {
        toolbarClosedRef.current = true;
      };
    }, []);
    const setToolbarItemStateFor = useCallback(
      (attempt: number, actionId: unknown, state: unknown): void => {
        if (toolbarClosedRef.current) return;
        if (attempt !== attemptRef.current || typeof actionId !== "string") return;
        const declared = getPanelKindConfig(kindId)?.pluginToolbar;
        if (!declared?.some((item) => item.stateKey === actionId)) return;
        usePluginPanelToolbarStore.getState().setItemState(panelId, actionId, state);
      },
      [panelId]
    );
    const setToolbarItemState = useMemo(
      () =>
        offerToolbar
          ? (actionId: string, state: PluginPanelToolbarItemState | null) =>
              setToolbarItemStateFor(retryCount, actionId, state)
          : undefined,
      [offerToolbar, setToolbarItemStateFor, retryCount]
    );
    /**
     * The view's menu list (#13213), held to the same attempt and teardown
     * guards as the toolbar. Vetted whole: a list the host would refuse is
     * dropped rather than half drawn.
     */
    const setMenuItemsFor = useCallback(
      (attempt: number, items: unknown): void => {
        if (toolbarClosedRef.current) return;
        if (attempt !== attemptRef.current) return;
        const result = normalizePanelMenuItems(
          items,
          pluginManifestIdFromInstanceKey(pluginId),
          pluginId
        );
        if (!result.ok) {
          logWarn(`[PluginViewContent] Plugin "${pluginId}" setMenuItems: ${result.error}`);
          return;
        }
        usePluginPanelMenuStore.getState().setViewItems(panelId, result.items);
      },
      [panelId]
    );
    const setMenuItems = useMemo(
      () =>
        offerToolbar
          ? (items: readonly PanelMenuItemContribution[] | null) =>
              setMenuItemsFor(retryCount, items)
          : undefined,
      [offerToolbar, setMenuItemsFor, retryCount]
    );
    /**
     * The view's name for its panel, held to the same attempt and teardown
     * guards as the menu, so a `disposeSignal` listener of a view that is going
     * away cannot rename a panel that lives on. Unlike the menu it is not
     * cleared on a reload or a crash: the title is saved with the panel and
     * outlives any one view.
     */
    const setTitleFor = useCallback(
      (attempt: number, title: unknown): void => {
        if (toolbarClosedRef.current) return;
        if (attempt !== attemptRef.current || !setPanelTitle) return;
        const normalized = normalizePluginPanelTitle(title);
        if (normalized === null) {
          logWarn(`[PluginViewContent] Plugin "${pluginId}" setTitle: expected a string or null`);
          return;
        }
        setPanelTitle(normalized);
      },
      [setPanelTitle]
    );
    const setTitle = useMemo(
      () => (setPanelTitle ? (title: string | null) => setTitleFor(retryCount, title) : undefined),
      [setPanelTitle, setTitleFor, retryCount]
    );
    // The project application's shared location (#14108), bound to this
    // attempt and its teardown like the setters above. A user-scope settings
    // section follows the user across projects, so it has no project to move.
    // An attempt whose dispose signal aborted — a kind removed under a mounted
    // view — is gone even before a retry bumps the counter.
    const isNavigationAttemptCurrent = useCallback(
      (attempt: number): boolean =>
        !toolbarClosedRef.current &&
        attempt === attemptRef.current &&
        !controllerRef.current.signal.aborted,
      []
    );
    const navigation = useApplicationNavigation({
      pluginId,
      panelId,
      enabled: !(hostContext.kind === "settings" && settingsContext?.scope === "user"),
      attempt: retryCount,
      isAttemptCurrent: isNavigationAttemptCurrent,
    });
    const runningActions = useAuthoredRunningActions(pluginId);

    // The user's reload reaches this mount through the lifecycle service, which
    // is how the menus and the action surface find a live view by panel id.
    useEffect(() => {
      if (!offerRequestReload) return;
      return registerUserViewReload(panelId, () => {
        if (aliveRef.current) handleReloadPanel();
      });
    }, [offerRequestReload, panelId, handleReloadPanel]);

    // An unmounted view holds nothing, so neither does the panel. Deferred and
    // called off by a replayed setup, like the dispose abort above: StrictMode
    // runs this cleanup and then the view's own effects, which may report
    // unsaved work again before this setup runs. A real unmount never re-runs
    // setup, so the retirement lands and a setter the view kept goes stale.
    const pendingUnsavedRetire = useRef<{ cancelled: boolean } | null>(null);
    useEffect(() => {
      if (pendingUnsavedRetire.current) {
        pendingUnsavedRetire.current.cancelled = true;
        pendingUnsavedRetire.current = null;
      }
      return () => {
        const retire = { cancelled: false };
        pendingUnsavedRetire.current = retire;
        queueMicrotask(() => {
          if (retire.cancelled) return;
          attemptRef.current += 1;
          retireUnsavedOwner();
        });
      };
    }, [retireUnsavedOwner]);

    // Stale content stays visible behind a terminal failure — it is the last
    // thing the plugin actually produced, and blanking it loses context the user
    // may still want to read — but it stops being interactive. Clicking a
    // control whose backend is gone does nothing and reports nothing, which
    // reads as the app being broken rather than the plugin.
    const contentInert = presentation.kind === "unavailable";

    // `inert` blanks focus inside the subtree, which would drop the user on
    // `document.body` with no way back. Move them onto the host-owned status
    // instead — but ONLY when focus was actually in there, so a panel going dark
    // in the background never steals focus from what the user is doing.
    //
    // Ownership is tracked as it happens rather than read back afterwards: this
    // effect runs after the commit that applied `inert`, by which point the
    // browser may already have blurred the descendant and `document.activeElement`
    // reads as `body`. A reload block, which unmounts the content outright,
    // strands focus the same way and takes the same rescue.
    const contentUnavailable = contentInert || reloadBlocked;
    useEffect(() => {
      if (!contentUnavailable) return;
      if (!focusIsInContent()) return;
      focusWasInsideContent.current = false;
      statusRef.current?.focus({ preventScroll: true });
    }, [contentUnavailable, focusIsInContent]);

    // A disabled builtin's activation is gone with it, so whatever re-enables
    // it has to activate before its view renders again.
    useEffect(() => {
      if (builtinDisabled) forgetActivation();
    }, [builtinDisabled]);

    // Whether the held attempt is the one to show. A stale attempt waits one
    // commit for the rebind effect, and must not start a `plugin://` import for
    // a builtin (or activate a kind that lost its slot) in the meantime.
    const showAttempt = !builtinDisabled && !reloadBlocked && attemptBuiltin === builtinComponent;

    // Start the attempt's load once it is the one on screen, and take its
    // result as ordinary state. A resolved load is a plain update the next
    // commit shows, where a Suspense retry would be held back to 300 ms after
    // the fallback committed. `run` is memoized, so a StrictMode replay or a
    // remount of this effect shares the one load; a result that lands after
    // unmount or replacement is dropped by the guard and by its attempt tag.
    useEffect(() => {
      if (!showAttempt) return;
      let current = true;
      attempt.run().then(
        (view) => {
          if (current) setSettled({ attempt, failed: false, view });
        },
        (error: unknown) => {
          if (current) setSettled({ attempt, failed: true, error });
        }
      );
      return () => {
        current = false;
      };
    }, [attempt, showAttempt]);

    const settledHere = settled !== null && settled.attempt === attempt ? settled : null;
    const loadFailure = settledHere?.failed ? settledHere : null;
    const View = settledHere && !settledHere.failed ? settledHere.view : null;
    // Nothing for the first 200 ms, then the skeleton, held for its floor once
    // it has shown (design-system loading gates). Outside Suspense, so the gate
    // and the floor are the only things standing between a load and its view.
    const loadPending = showAttempt && View === null && loadFailure === null;
    const showSkeleton = useSkeletonFloor(useSkeletonGate(loadPending));

    return (
      // Outside the boundary, not inside: the fallback is rendered BY the
      // boundary, so a provider nested within it would be unmounted exactly when
      // the fallback needs the close callback.
      <PluginViewCloseContext.Provider value={closeContextValue}>
        {/* The host-owned layer, outside the boundary AND the Suspense: a
            backend failure is the host's to report, and nesting the report
            inside the subtree it describes would let a crashed view take its own
            explanation down with it (#11231, #12278). It is deliberately NOT
            inside the plugin's style root either, so a plugin stylesheet cannot
            restyle the control that recovers from it. */}
        {/* Focusable so the rescue below has somewhere to put focus when the
            content it was inside goes inert. The ring is deliberately NOT
            suppressed: focus arrives here programmatically, and a visible ring
            is what tells the user where it went. Only while the status is
            empty does it go, since a solid outline on a zero-height box is a
            stray accent stripe. */}
        {/* eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- only while empty: a solid ring on a zero-height focus park is a stray stripe */}
        <div ref={statusRef} tabIndex={-1} className="empty:outline-hidden">
          {/* Worker state, which a plugin the user switched off does not have —
              and a "Plugin stopped / Restart" line over the explanation below
              would offer to restart something nobody asked to run. The wrapper
              stays either way: it is where focus is rescued to. */}
          {builtinDisabled ? null : (
            <PluginViewRuntimeStatus
              presentation={presentation}
              panelDisplayName={displayName}
              onRestartPlugin={handleRestartPlugin}
              restarting={restarting}
              reloadBlocked={reloadBlocked}
              onReloadPanel={handleReloadPanel}
            />
          )}
        </div>
        {/* A disabled builtin renders no view — but a header over an empty pane
            says nothing about why, so the pane says it instead, and points at
            the one place the plugin can be switched back on. Outside the style
            root, the boundary and the Suspense: none of them belong to a view
            that was never built. */}
        {builtinDisabled ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              className="my-auto w-full shrink-0"
              icon={<Package />}
              title="Enable this plugin"
              // Unnamed on purpose: `displayName` is the panel kind's name, not
              // the plugin's, so naming it here would send the user looking for
              // "Site Inspector" in a manager that lists "SvelteKit Tools".
              description="This plugin's turned off. Enable it in the plugin manager to use this view."
              action={
                <Button
                  variant="contrast"
                  size="sm"
                  onClick={() => {
                    void actionService.dispatch("app.pluginManager", undefined, {
                      source: "user",
                    });
                  }}
                >
                  Manage plugins
                </Button>
              }
            />
          </div>
        ) : null}
        {/* It must not fall through to the `plugin://` path either: a builtin
            ships no bundle there to import. A stale attempt waits one commit
            for the rebind effect. */}
        {/* A panel stopped for reloading too often renders no view at all —
            the banner above is the whole pane until the user reloads it. */}
        {!showAttempt ? null : (
          <ErrorBoundary
            // The attempt counter is the boundary's KEY, not its `resetKeys`.
            //
            // A fresh attempt alone does not remount anything: React compares
            // the view's component type, so an attempt that loads the same
            // module export reuses the existing fiber — the view keeps its state
            // and its `deps: []` subscriptions while `replaceAttempt` has already
            // aborted the `disposeSignal` those subscriptions were tied to. That
            // combination is worse than not recovering at all. Remounting the
            // whole boundary subtree is what makes an attempt genuinely new.
            //
            // It also gives attempt replacement a single owner. `resetKeys` made
            // `componentDidUpdate` call `onReset` whenever the key changed while
            // the fallback was up — so a backend rebind landing on a crashed view
            // built the attempt twice. A remounted boundary starts with no error,
            // so there is nothing left for an auto-reset to do.
            key={retryCount}
            variant="component"
            // `kindId` is already `${pluginId}.${panel.id}` (PluginService builds
            // it that way), so prefixing pluginId again doubled it.
            componentName={`PluginView:${kindId}`}
            fallback={PluginViewFallback}
            onError={handleRenderError}
            onReset={handleReset}
          >
            {loadFailure ? (
              <PluginViewLoadFailure error={loadFailure.error} />
            ) : View === null || showSkeleton ? (
              showSkeleton ? (
                <PluginViewLoadingSkeleton displayName={displayName} />
              ) : null
            ) : (
              // Only a view that suspends on its own reaches this fallback; the
              // load above never suspends.
              <Suspense fallback={<PluginViewSuspendedFallback displayName={displayName} />}>
                <ContentFadeIn
                  className={cn(
                    "flex flex-col flex-1 min-h-0 w-full",
                    contentInert && "opacity-60"
                  )}
                  // Native `inert`, not `pointer-events-none` + `aria-hidden`: the
                  // CSS pair stops the mouse but leaves every control tabbable and
                  // Enter-activatable, and `aria-hidden` around a focused element is
                  // the exact shape Chromium refuses to hide. `inert` removes the
                  // subtree from focus, hit-testing and the accessibility tree in one
                  // go, which is the whole claim being made about stale content.
                  inert={contentInert}
                  onFocus={() => {
                    focusWasInsideContent.current = true;
                  }}
                  onBlur={(e) => {
                    // Not while going inert: applying the attribute is itself what
                    // blurred the descendant, and clearing here would erase the very
                    // fact the rescue above needs.
                    if (contentInert) return;
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                      focusWasInsideContent.current = false;
                    }
                  }}
                  ref={styleRootRef}
                  // Marks keys that reached this view through React, portals
                  // included, for the kit's view-scoped hotkeys.
                  onKeyDownCapture={(e) => kitViewHost.keyEvents.add(e.nativeEvent)}
                  {...styleRootProps}
                >
                  <Profiler id={kindId} onRender={onViewCommit}>
                    {/* Kit overlays portal out of the root above; this is how
                          they still name the plugin that owns them. */}
                    <PluginKitOwnerContext.Provider value={pluginId}>
                      <PluginKitViewHostContext.Provider value={kitViewHost}>
                        <View
                          panelId={panelId}
                          pluginId={pluginId}
                          disposeSignal={controller.signal}
                          panelRemovedSignal={panelRemovedSignal}
                          initialArgs={mountArgs}
                          openRequest={openRequest}
                          stateVersion={mountStateVersion}
                          persistState={persistState}
                          requestReload={requestReload}
                          setHasUnsavedChanges={setHasUnsavedChanges}
                          setToolbarItemState={setToolbarItemState}
                          setMenuItems={setMenuItems}
                          setTitle={setTitle}
                          runningActions={runningActions}
                          worktreeId={worktreeId}
                          styleRootAttributes={styleRootProps}
                          {...(settingsContext ? { settingsContext } : {})}
                          {...(fileDocument ? { fileDocument } : {})}
                          hostContext={hostContext}
                          {...(navigation ? { navigation } : {})}
                        />
                      </PluginKitViewHostContext.Provider>
                    </PluginKitOwnerContext.Provider>
                  </Profiler>
                  <PluginViewPaintReporter
                    timing={attempt.timing}
                    schedule={scheduleFirstPaintSample}
                  />
                  <PluginViewMountReporter
                    panelId={panelId}
                    kindId={kindId}
                    pluginId={pluginId}
                    attempt={retryCount}
                    onCommit={markAttemptCommitted}
                    openRequestSeq={openRequest?.seq}
                  />
                </ContentFadeIn>
              </Suspense>
            )}
          </ErrorBoundary>
        )}
      </PluginViewCloseContext.Provider>
    );
  }

  PluginViewContent.displayName = `PluginViewContent(${kindId})`;
  return PluginViewContent;
}

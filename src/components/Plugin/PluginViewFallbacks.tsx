import { createContext, useContext, useEffect, useLayoutEffect } from "react";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { reportViewMounted } from "@/services/plugin/pluginPanelLifecycle";
import type { ErrorFallbackProps } from "@/components/ErrorBoundary/ErrorFallback";
import { Skeleton, SkeletonHint } from "@/components/ui/Skeleton";
import { PluginViewDiagnosticsFallback } from "@/components/Plugin/PluginViewDiagnosticsFallback";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { usePluginPanelOpenRequestStore } from "@/store/pluginPanelOpenRequestStore";
import { isPluginNotOnHostError, isRemoteUnsupportedError } from "./remotePluginView";
import { PluginRemoteUnsupportedPlaceholder } from "./PluginRemoteUnsupportedPlaceholder";
import {
  PluginViewBlockedPlaceholder,
  isPluginViewBlockedError,
} from "./PluginViewBlockedPlaceholder";
import { PluginNotOnHostPlaceholder } from "./PluginNotOnHostPlaceholder";
import type { ViewLoadTiming } from "./pluginViewLoader";

/**
 * Carries the host's close callback down to the factory-scoped fallback without
 * putting it in the fallback's component identity. Default is an empty object so
 * a content instance mounted without a host (tests, a future embedder) simply
 * renders no close button.
 */
export const PluginViewCloseContext = createContext<{
  onRequestClose?: () => void;
  requestCloseLabel?: string;
}>({});

export interface PluginViewFallbackConfig {
  pluginId: string;
  kindId: string;
  displayName: string;
  componentPath: string;
}

/**
 * Build the boundary fallback for one content factory. Call it once per
 * factory, never in render: the boundary swaps its fallback subtree whenever
 * this component *type* changes identity, which would remount the diagnostics
 * pane (and drop its copy feedback) on every render. That stability is also
 * why the per-instance close callback arrives through
 * {@link PluginViewCloseContext} instead of a prop — a closure over
 * `onRequestClose` would change the component type on every render of the
 * owning panel.
 */
export function createPluginViewFallback({
  pluginId,
  kindId,
  displayName,
  componentPath,
}: PluginViewFallbackConfig) {
  function PluginViewFallback({ error, errorInfo, resetError, incidentId }: ErrorFallbackProps) {
    const { onRequestClose, requestCloseLabel } = useContext(PluginViewCloseContext);
    // A host that names its own way out (the sidebar's "Show worktrees") offers
    // it from every placeholder; a panel's close stays on the panel's chrome.
    const leave =
      onRequestClose !== undefined && requestCloseLabel !== undefined
        ? { label: requestCloseLabel, onClick: onRequestClose }
        : undefined;
    // Two primitive selectors rather than one object selector: the meta record
    // is rebuilt on every provenance pull, so selecting it whole would re-render
    // the pane on pulls that changed nothing about this plugin.
    const devMode = usePluginRuntimeStore((s) => s.pluginMetaById.get(pluginId)?.devMode === true);
    const pluginDisplayName = usePluginRuntimeStore(
      (s) =>
        s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
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

    // Not a failure: the host declined to start this plugin for a window on
    // another machine. Nothing here is broken, so there are no diagnostics.
    if (isRemoteUnsupportedError(error)) {
      return (
        <PluginRemoteUnsupportedPlaceholder pluginDisplayName={pluginDisplayName} leave={leave} />
      );
    }
    // This computer didn't run the host's view: the person's choice, not a bug.
    if (isPluginViewBlockedError(error)) {
      return (
        <PluginViewBlockedPlaceholder
          pluginDisplayName={pluginDisplayName}
          onRetry={resetError}
          leave={leave}
        />
      );
    }
    // The window's host doesn't have this plugin (any more). Also not broken.
    if (isPluginNotOnHostError(error)) {
      return (
        <PluginNotOnHostPlaceholder
          pluginId={pluginId}
          kind={kindId}
          pluginDisplayName={pluginDisplayName}
          onRemove={onRequestClose}
          {...(requestCloseLabel !== undefined ? { removeLabel: requestCloseLabel } : {})}
        />
      );
    }

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
        {...(requestCloseLabel !== undefined ? { requestCloseLabel } : {})}
      />
    );
  }

  return PluginViewFallback;
}

/**
 * Hands a failed load to the boundary. The load settles outside render, so
 * its rejection has to be rethrown from inside the boundary's subtree for the
 * boundary to catch it — with the same error object, which is what keeps the
 * import-stage classification (#11728) intact.
 */
export function PluginViewLoadFailure({ error }: { error: unknown }): never {
  throw error;
}

/**
 * Content-only bones: the presentation host already paints the real header,
 * so a skeleton carrying its own (BrowserPaneSkeleton) would double it.
 * Mirrors DevPreviewPaneFallback's quiet canvas — a plugin's content shape is
 * unknowable, so bones must not imply one. No pulse to delay: every caller
 * has already waited out the skeleton gate before rendering it.
 */
export function PluginViewLoadingSkeleton({ displayName }: { displayName: string }) {
  return (
    <div className="relative h-full">
      <Skeleton label={`Loading ${displayName}`} className="h-full bg-surface-canvas" />
      <SkeletonHint className="absolute bottom-8 inset-x-4 flex justify-center pointer-events-auto" />
    </div>
  );
}

/**
 * For a view that suspends on its own after it has loaded — a builtin's
 * registered `lazy()` chunk, or a plugin's own lazy child. The load path
 * never suspends, so this is the only Suspense fallback left, and it is
 * gated like the load path's skeleton.
 */
export function PluginViewSuspendedFallback({ displayName }: { displayName: string }) {
  const show = useSkeletonGate(true);
  return show ? <PluginViewLoadingSkeleton displayName={displayName} /> : null;
}

/**
 * Completes an attempt's load sample at the first frame that can show it.
 * Rendered beside the view inside the same Suspense boundary, so its layout
 * effect runs in the commit that reveals the loaded view (for a view that
 * suspends on a nested chunk of its own, the commit that reveals that chunk),
 * before the browser paints it. The next animation frame is the first that can show
 * that commit, and its timestamp is when that frame began, before its paint:
 * a first-frame figure, not a measured paint time.
 *
 * A layout effect and one frame, not a passive effect and two: a passive
 * effect runs after the view's own mount effects, and a view that loads its
 * data there pushed the second frame out behind that render, reporting the
 * first frame 140-170 ms after the view was on screen. A view that throws while
 * rendering unwinds this with it, so a failed load records no sample.
 */
export function PluginViewPaintReporter({
  timing,
  schedule,
}: {
  timing: ViewLoadTiming;
  /** The owning factory's sampler, which marks `timing` recorded. */
  schedule: (timing: ViewLoadTiming) => () => void;
}) {
  useLayoutEffect(() => schedule(timing), [timing, schedule]);
  return null;
}

/**
 * Reports "a view is live for this panel" as a commit-time effect. Rendered as
 * a sibling of the resolved view inside the same boundary, so if the view
 * throws during render React unwinds the whole subtree and this effect never
 * runs — which is what keeps `mounted` honest rather than optimistic.
 */
export function PluginViewMountReporter({
  panelId,
  kindId,
  pluginId,
  attempt,
  onCommit,
  openRequestSeq,
}: {
  panelId: string;
  kindId: string;
  pluginId: string;
  attempt: number;
  onCommit: (attempt: number) => void;
  /** The open request the view committed with, if any. */
  openRequestSeq: number | undefined;
}) {
  useEffect(
    () => reportViewMounted(panelId, { kindId, pluginId }),
    // `kindId`/`pluginId` are fixed per content factory, so in practice this
    // runs once per panel.
    [panelId, kindId, pluginId]
  );
  useEffect(() => {
    onCommit(attempt);
  }, [attempt, onCommit]);
  // Delivered only once a view has committed with it: a view that throws
  // while rendering unwinds this effect with it, so the request is still
  // waiting for the retry. A layout effect, because a passive one can run
  // after the microtask a `requestReload` from the view's own layout effect
  // acts in, and the replacement would then read the request as undelivered.
  useLayoutEffect(() => {
    if (openRequestSeq === undefined) return;
    usePluginPanelOpenRequestStore.getState().markDelivered(panelId, openRequestSeq);
  }, [panelId, openRequestSeq]);
  return null;
}

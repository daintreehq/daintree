import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { ProjectSurfaceClaim, ProjectSurfaceSlot } from "@shared/types/plugin";
import {
  makePluginViewContent,
  type PluginViewContentProps,
} from "@/components/Plugin/PluginViewContent";
import { usePluginProjectSurfacesStore } from "@/store/pluginProjectSurfacesStore";

/**
 * The panel-kind metadata behind a surface claim, or `undefined` while the
 * kind has not registered in this renderer yet.
 *
 * Read through `useSyncExternalStore` rather than a bare `getPanelKindConfig`
 * because the two facts arrive on independent round trips: the surfaces pull
 * and `usePluginPanelKinds`' own pull/push. Whichever lands second must
 * re-render, or a project whose kinds arrived last would sit on stock content
 * with a claim it never applied.
 */
function usePanelKindConfig(kindId: string | undefined): PanelKindConfig | undefined {
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  return kindId === undefined ? undefined : registry[kindId];
}

/**
 * A resolved surface claim: the slot's owner plus the panel-kind metadata its
 * view renders from. `null` while the claim is absent, suppressed, or not yet
 * resolvable — every one of which means "draw the stock surface".
 */
export interface ResolvedProjectSurface {
  claim: ProjectSurfaceClaim;
  config: PanelKindConfig;
}

/**
 * Resolve one surface slot for this project view.
 *
 * Returns `null` when the user has pinned the stock canvas: the pin is what
 * guarantees a plugin can never take the host's own launcher away, so it is
 * checked here rather than at each call site, where it could be forgotten.
 *
 * A claim whose kind carries no `componentPath` (a PTY panel, or a view the
 * panels loop skipped) resolves to `null` too — a surface renders a module, and
 * there is nothing to render without one.
 */
export function useProjectSurface(slot: ProjectSurfaceSlot): ResolvedProjectSurface | null {
  const init = usePluginProjectSurfacesStore((s) => s.init);
  // In an effect, not during render: `init` sets store state on the pull's
  // resolution, and the first call must not run inside the render that reads it.
  useEffect(() => {
    init();
  }, [init]);
  const claim = usePluginProjectSurfacesStore((s) => s.surfaces[slot]);
  const pinned = usePluginProjectSurfacesStore((s) => s.stockCanvasPinned);
  const config = usePanelKindConfig(claim?.panelKindId);
  if (claim === undefined || pinned) return null;
  if (config === undefined || config.componentPath === undefined) return null;
  return { claim, config };
}

/**
 * A surface's per-kind runtime: the content factory and the removal signal that
 * stands in for a panel record's.
 *
 * `makePluginViewContent` must run outside render, as it does for panel hosts in
 * `usePluginPanelKinds` — a factory minted during render would be a new
 * component type each time, remounting the plugin's view and restarting its
 * `plugin://` import. Keyed by kind, with the component path recorded so an
 * upgraded plugin (which gets a fresh generation segment in its path) mints a
 * new one rather than reusing a factory bound to the old module URL.
 */
interface SurfaceRuntime {
  componentPath: string;
  content: ComponentType<PluginViewContentProps>;
  /** Aborted when this kind leaves the registry — the surface's "removed". */
  removal: AbortController;
}

const surfaceRuntimes = new Map<string, SurfaceRuntime>();
let pruneSubscribed = false;

/**
 * Retire every runtime whose kind is gone from the registry or has moved to a
 * new module URL.
 *
 * Two jobs in one sweep, because they have the same trigger. It aborts the
 * removal signal, which for a surface means what a panel record's means — the
 * thing is permanently gone, not merely unmounted (a surface unmounts whenever
 * the user opens a panel, and that must not read as removal). And it drops the
 * factory, so the map cannot grow one closure per plugin reload for the life of
 * the renderer.
 */
function pruneSurfaceRuntimes(): void {
  const registry = getPanelKindRegistrySnapshot();
  for (const [kindId, runtime] of surfaceRuntimes) {
    const config = registry[kindId];
    if (config !== undefined && config.componentPath === runtime.componentPath) continue;
    runtime.removal.abort();
    surfaceRuntimes.delete(kindId);
  }
}

function getSurfaceRuntime(config: PanelKindConfig): SurfaceRuntime {
  if (!pruneSubscribed) {
    // Subscribed on first use rather than at module scope so importing this
    // module has no side effect. Never unsubscribed: the map it sweeps is
    // module-level, and a torn-down subscription would strand every entry.
    subscribeToPanelKindRegistry(pruneSurfaceRuntimes);
    pruneSubscribed = true;
  }
  const componentPath = config.componentPath ?? "";
  const existing = surfaceRuntimes.get(config.id);
  if (existing !== undefined && existing.componentPath === componentPath) return existing;
  existing?.removal.abort();
  const runtime: SurfaceRuntime = {
    componentPath,
    content: makePluginViewContent({
      id: config.id,
      name: config.name,
      componentPath,
      extensionId: config.extensionId ?? "",
    }),
    removal: new AbortController(),
  };
  surfaceRuntimes.set(config.id, runtime);
  return runtime;
}

/** Test-only: drop every cached factory and its removal signal. */
export function _resetProjectSurfaceRuntimesForTest(): void {
  for (const runtime of surfaceRuntimes.values()) runtime.removal.abort();
  surfaceRuntimes.clear();
}

/**
 * Mount a project surface's view.
 *
 * Deliberately reuses `PluginViewContent` — the same loader, the same standard
 * plugin error boundary, and the same working "Try again" a contributed panel
 * gets — so a surface that throws lands on the house diagnostics pane rather
 * than a blank region, and its teardown ordering (`disposeSignal`) matches a
 * normal plugin view exactly.
 *
 * `panelId` is synthesized from the kind: a surface is not a panel instance, but
 * the view contract takes an opaque panel id, and one stable per kind keeps the
 * value meaningful for plugin-local storage keys across re-renders. Because it
 * names no panel record, the removal signal is supplied rather than looked up —
 * see {@link pruneSurfaceRuntimes}.
 *
 * No `onRequestClose`: a surface has no panel to trash. The way out of a broken
 * surface is `ProjectSurfaceFrame`'s switch back to the stock canvas, which is
 * why this wrapper isolates and contains the plugin's layout: `isolation`
 * caps the plugin's z-indexes inside its own stacking context, and
 * `contain: layout paint` (with `overflow-hidden`) keeps a `position: fixed`
 * descendant inside this box. A surface can then style its own region freely
 * and still never paint over the control that leads out of it.
 */
export function ProjectSurfaceView({ config }: { config: PanelKindConfig }) {
  const { content: Content, removal } = getSurfaceRuntime(config);
  return (
    <div
      className="relative isolate h-full w-full min-h-0 min-w-0 overflow-hidden"
      style={{ contain: "layout paint" }}
    >
      <Content panelId={`surface:${config.id}`} panelRemovedSignal={removal.signal} />
    </div>
  );
}

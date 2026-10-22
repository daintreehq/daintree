import type { ComponentType } from "react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type {
  PluginFileDocument,
  PluginHostedViewDescriptor,
  PluginSettingsViewContext,
  PluginViewHostKind,
} from "@shared/types/plugin";
import {
  makePluginViewContent,
  pluginViewHostContext,
  type PluginViewContentProps,
} from "@/components/Plugin/PluginViewContent";
import { usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";
import { cn } from "@/lib/utils";

/**
 * What a hosted mount draws: a view from the hosted-view registry (one that
 * mounts only outside the grid), or a panel kind's view drawn outside the grid
 * — a project surface shows one of its plugin's panels in place of the host's
 * own content, and that panel stays spawnable on purpose.
 */
export type PluginHostedViewSource =
  | { from: "hosted"; view: PluginHostedViewDescriptor }
  | { from: "panel-kind"; config: PanelKindConfig };

/**
 * One source's runtime: the content factory, the module URL it was minted for,
 * and the removal signal that stands in for a panel record's.
 */
interface HostedViewRuntime {
  from: PluginHostedViewSource["from"];
  componentPath: string;
  content: ComponentType<PluginViewContentProps>;
  /** Aborted when the source is withdrawn or moves to a new module — its "removed". */
  removal: AbortController;
}

/** Keyed by kind id: a hosted id (`plugin-view:` prefix) and a panel kind id never collide. */
const runtimes = new Map<string, HostedViewRuntime>();
let unsubscribeRetirement: (() => void) | null = null;

/**
 * Retire every runtime whose source is gone or now serves a different module.
 *
 * Two jobs in one sweep, because they share a trigger. It aborts the removal
 * signal, which here means what a panel record's means — the view is
 * permanently gone, not merely unmounted. A hosted view unmounts whenever its
 * home closes (Settings, or the canvas when the user opens a panel), and that
 * must not read as removal; a plugin that stops, reloads onto a new module or
 * is hidden in this project must, whether or not anything is showing it. And
 * it drops the factory, so the map can't grow one closure per plugin reload.
 *
 * Hosted views answer to the hosted-view snapshot, surfaces to the panel kind
 * registry; each sweep checks every runtime against the one it came from.
 */
function retireStaleRuntimes(): void {
  const hosted = usePluginHostedViewsStore.getState().views;
  const registry = getPanelKindRegistrySnapshot();
  for (const [id, runtime] of runtimes) {
    let current: string | undefined;
    if (runtime.from === "hosted") {
      // No snapshot yet is "unknown", not "withdrawn".
      if (hosted === null) continue;
      current = hosted.find((view) => view.id === id)?.componentPath;
    } else {
      current = registry[id]?.componentPath;
    }
    if (current === runtime.componentPath) continue;
    runtime.removal.abort();
    runtimes.delete(id);
  }
}

/**
 * Subscribed on first use rather than at module scope, so importing this module
 * has no side effect. Kept for the life of the renderer: the map it sweeps is
 * module-level, and retirement has to happen while nothing is mounted too.
 */
function ensureRetirementSubscription(): void {
  if (unsubscribeRetirement !== null) return;
  const offHosted = usePluginHostedViewsStore.subscribe(retireStaleRuntimes);
  const offRegistry = subscribeToPanelKindRegistry(retireStaleRuntimes);
  unsubscribeRetirement = () => {
    offHosted();
    offRegistry();
  };
}

function describe(source: PluginHostedViewSource) {
  if (source.from === "hosted") {
    const { view } = source;
    return {
      id: view.id,
      // A hosted id names no panel kind, so the kind-registry teardown would
      // read every broadcast as removal; the sweep above retires it instead.
      config: {
        id: view.id,
        name: view.name,
        componentPath: view.componentPath,
        extensionId: view.pluginId,
        standalone: true,
      },
    };
  }
  const { config } = source;
  return {
    id: config.id,
    // A real panel kind: the loader's own `plugin:panel-kinds-changed`
    // teardown applies, exactly as for the same view in a panel.
    config: {
      id: config.id,
      name: config.name,
      componentPath: config.componentPath ?? "",
      extensionId: config.extensionId ?? "",
    },
  };
}

/**
 * The content factory for a source, minted once per module URL.
 *
 * `makePluginViewContent` must run outside render — a factory minted during
 * render is a new component type each time, which would remount the view and
 * restart its `plugin://` import on every render. A reloaded plugin gets a
 * fresh generation segment in its URL, so a new path retires the old runtime
 * rather than reusing a factory bound to the old module.
 */
function getRuntime(source: PluginHostedViewSource): HostedViewRuntime {
  ensureRetirementSubscription();
  const { id, config } = describe(source);
  const existing = runtimes.get(id);
  if (existing !== undefined && existing.componentPath === config.componentPath) return existing;
  existing?.removal.abort();
  const runtime: HostedViewRuntime = {
    from: source.from,
    componentPath: config.componentPath,
    content: makePluginViewContent(config),
    removal: new AbortController(),
  };
  runtimes.set(id, runtime);
  return runtime;
}

/** Test-only: drop every cached factory, its removal signal and the subscriptions. */
export function _resetPluginHostedViewRuntimesForTest(): void {
  for (const runtime of runtimes.values()) runtime.removal.abort();
  runtimes.clear();
  unsubscribeRetirement?.();
  unsubscribeRetirement = null;
}

/** Test-only: the removal signal of a source's cached runtime, if it has one. */
export function _pluginHostedViewRemovalSignalForTest(id: string): AbortSignal | undefined {
  return runtimes.get(id)?.removal.signal;
}

/**
 * Mount a plugin view outside the panel grid — the one path every such host
 * uses, so a settings section, a project surface and whatever comes next get
 * the same contract a panel view does.
 *
 * The content is the shared plugin-view loader: the same activation, lazy
 * `plugin://` import, standard error boundary with "Try again", per-attempt
 * `disposeSignal` and style root. The host adds only what a panel record would
 * otherwise supply — an opaque `mountId` for `panelId`, and a removal signal
 * that outlives remounts (see {@link retireStaleRuntimes}) — plus the
 * `hostContext` naming where the view is. No reload or toolbar: those police a
 * panel record a hosted view doesn't have. A host with a way out of a broken
 * view (the sidebar's "Show worktrees") passes it as `onRequestClose` with
 * the words for its button.
 *
 * The box isolates and contains the plugin's layout: `isolate` caps its
 * z-indexes in its own stacking context, and `contain: layout paint` with
 * overflow clipping keeps a `position: fixed` descendant inside, so no view can
 * paint over the host chrome around it. A flex COLUMN, because the loader fills
 * its host with `flex-1 min-h-0`, which is inert outside a flex container
 * (#12361). Callers size the box; anything outside it is not the view's.
 */
export function PluginHostedView({
  source,
  host,
  mountId,
  settingsContext,
  onRequestClose,
  requestCloseLabel,
  fileDocument,
  className,
  testId,
}: {
  source: PluginHostedViewSource;
  host: Exclude<PluginViewHostKind, "panel">;
  /**
   * Handed to the view as `panelId`: opaque, and stable per home so per-mount
   * state the view keys by it stays put across re-renders.
   */
  mountId: string;
  settingsContext?: PluginSettingsViewContext;
  /** The failure fallback's way out, beside "Try again"; omitted, there is none. */
  onRequestClose?: () => void;
  requestCloseLabel?: string;
  fileDocument?: PluginFileDocument;
  className?: string;
  testId?: string;
}) {
  const { content: Content, removal } = getRuntime(source);
  return (
    <div
      className={cn("relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden", className)}
      style={{ contain: "layout paint" }}
      data-testid={testId}
    >
      <Content
        panelId={mountId}
        panelRemovedSignal={removal.signal}
        hostContext={pluginViewHostContext(host)}
        {...(settingsContext ? { settingsContext } : {})}
        {...(onRequestClose ? { onRequestClose } : {})}
        {...(requestCloseLabel !== undefined ? { requestCloseLabel } : {})}
        {...(fileDocument ? { fileDocument } : {})}
      />
    </div>
  );
}

/**
 * The documented plugin-view bridge on `window.electron.plugin`: `invoke`
 * (request/response), `on` (broadcast subscribe) and `onPanel` (per-instance
 * subscribe), each subscription returning its disposer.
 *
 * `@daintreehq/plugin-sdk/view-globals` declares the same shape as the global
 * `DaintreePluginViewBridge` for authors (kept React-free, so it cannot import
 * this one; `viewGlobalsTypes.test.ts` holds the two equal). The SDK resolves
 * the bridge through a local cast rather than that global because the host app
 * compiles these hooks too and declares its own, wider `Window.electron`,
 * which a second global declaration would conflict with.
 */
export interface PluginHostBridge {
  invoke(pluginId: string, channel: string, ...args: unknown[]): Promise<unknown>;
  on(pluginId: string, channel: string, callback: (payload: unknown) => void): () => void;
  onPanel(
    pluginId: string,
    channel: string,
    panelId: string,
    callback: (payload: unknown) => void
  ): () => void;
}

/**
 * The project-view cache edges main broadcasts on `window.electron.app`. Not
 * part of the plugin API (docs/plugins/views.md → "Project switches and
 * staleness"): the SDK probes it so its hooks can pause while the view is
 * cached, and every member is optional so a host without it reads as "never
 * cached".
 */
interface ViewLifecycleBridge {
  isViewCached?: () => boolean;
  onViewCached?: (callback: () => void) => () => void;
  onViewWarmActivated?: (callback: () => void) => () => void;
}

interface PluginBridgeGlobal {
  electron?: { plugin?: PluginHostBridge; app?: ViewLifecycleBridge };
}

/**
 * Resolve the plugin host bridge from the renderer global. Throws a clear error
 * when called outside a Daintree renderer (e.g. SSR, a unit test that forgot to
 * stub `window.electron`) so the failure names the missing bridge rather than
 * surfacing an opaque "cannot read properties of undefined".
 */
export function getPluginHostBridge(): PluginHostBridge {
  const root = globalThis as unknown as PluginBridgeGlobal;
  const bridge = root.electron?.plugin;
  if (!bridge) {
    throw new Error(
      "@daintreehq/plugin-sdk/react: window.electron.plugin is unavailable — these hooks run only inside a Daintree plugin renderer view."
    );
  }
  return bridge;
}

/**
 * Whether nobody can see this view right now: its project view is cached by
 * main, or the document is hidden (window minimised or occluded). `onChange`
 * runs on every edge that can flip it; read the state again there. Returns the
 * unsubscribe. Outside a browser it reports "active" and subscribes nothing.
 */
export function subscribeViewIdle(onChange: () => void): {
  isIdle: () => boolean;
  dispose: () => void;
} {
  const doc = typeof document === "undefined" ? null : document;
  const app = (globalThis as unknown as PluginBridgeGlobal).electron?.app;
  const isIdle = (): boolean => {
    let cached: boolean;
    try {
      cached = app?.isViewCached?.() === true;
    } catch {
      cached = false;
    }
    return cached || doc?.hidden === true;
  };
  const offs: Array<() => void> = [];
  // Edges, not state: nothing replays, so the caller seeds from `isIdle()`.
  // Warm activation, not reveal, is the cached-to-active edge.
  const offCached = app?.onViewCached?.(onChange);
  if (typeof offCached === "function") offs.push(offCached);
  const offActive = app?.onViewWarmActivated?.(onChange);
  if (typeof offActive === "function") offs.push(offActive);
  if (doc) {
    doc.addEventListener("visibilitychange", onChange);
    offs.push(() => doc.removeEventListener("visibilitychange", onChange));
  }
  return {
    isIdle,
    dispose: () => {
      for (const off of offs.splice(0)) off();
    },
  };
}

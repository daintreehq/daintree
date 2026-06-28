/**
 * Narrow runtime view of the host bridge the renderer SDK hooks call. The full
 * surface lives on `window.electron.plugin` (typed in the host app via
 * `ElectronAPI`); the SDK only needs `invoke` (request/response), `on`
 * (broadcast subscribe), and `onPanel` (per-instance subscribe) — each returns a
 * disposer — so it declares just those here and resolves
 * the bridge from the global at call time. This keeps the package self-contained
 * — it does not depend on the host app's ambient `Window.electron` declaration —
 * while remaining the single canonical implementation the host bundle re-exports.
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

interface PluginBridgeGlobal {
  electron?: { plugin?: PluginHostBridge };
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

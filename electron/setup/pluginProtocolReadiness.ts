/**
 * Whether the `plugin://` handler has been pointed at the live authority
 * resolver yet (#12996).
 *
 * Kept dependency-free, apart from `protocols.ts`, so PluginService can gate its
 * loads on it without pulling the protocol module into its import graph.
 * Process-lifetime: it goes live once and never goes back.
 */

let live = false;
let resolveLive: () => void = () => {};
const livePromise = new Promise<void>((resolve) => {
  resolveLive = resolve;
});

export function markPluginDirResolverLive(): void {
  if (live) return;
  live = true;
  resolveLive();
}

export function isPluginDirResolverLive(): boolean {
  return live;
}

export function whenPluginDirResolverLive(): Promise<void> {
  return livePromise;
}

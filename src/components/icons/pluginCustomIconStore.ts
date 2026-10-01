import type { PluginCustomIconAsset } from "@shared/config/pluginCustomIcon";

/**
 * This view's copy of main's plugin custom-icon snapshot (#13143). A plain
 * external store rather than zustand: icon components read it through
 * `useSyncExternalStore`, and nothing else needs it.
 */
let icons: ReadonlyMap<string, PluginCustomIconAsset> = new Map();
const listeners = new Set<() => void>();

/** Replace the snapshot wholesale; keys absent from `next` stop resolving. */
export function setPluginCustomIcons(next: readonly PluginCustomIconAsset[]): void {
  icons = new Map(next.map((icon) => [icon.key, icon]));
  for (const listener of listeners) listener();
}

export function getPluginCustomIcon(key: string): PluginCustomIconAsset | undefined {
  return icons.get(key);
}

export function subscribePluginCustomIcons(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

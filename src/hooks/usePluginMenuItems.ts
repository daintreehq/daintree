import { useState, useEffect } from "react";
import type { MenuItemContribution, MenuItemLocation } from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

export interface PluginMenuItemEntry {
  pluginId: string;
  item: MenuItemContribution;
}

/**
 * Pull plugin-contributed menu items for a given location on mount and keep
 * them in sync with main's authoritative set via push. Pull-on-mount is a
 * safety net for cached `WebContentsView`s that may have missed a broadcast;
 * push is authoritative — once a push arrives, a later-resolving mount-time
 * pull is dropped to avoid rolling back state (mirrors
 * {@link usePluginToolbarButtons}).
 *
 * Unlike toolbar buttons there is no `complete`/sweep path: menu items carry no
 * persisted renderer-side state, so every snapshot is a full replacement.
 *
 * `when` is passed through unfiltered for now — the when-clause evaluator
 * (#9273) is not yet wired, and items without a `when` are always visible, so
 * the safe interim behavior is to show every contributed item. Filtering moves
 * here once #9273 lands.
 */
export function usePluginMenuItems(location: MenuItemLocation): PluginMenuItemEntry[] {
  const [items, setItems] = useState<PluginMenuItemEntry[]>([]);

  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const sync = (entries: PluginMenuItemEntry[]): void => {
      if (disposed) return;
      setItems(entries.filter((entry) => entry.item.location === location));
    };

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .menuItems()
      .then((entries) => {
        if (disposed) return;
        if (pushReceived) return;
        sync(entries);
      })
      .catch((err: unknown) => {
        logWarn("[PluginMenuItems] Failed to fetch initial plugin menu items", { error: err });
      });

    const cleanup = electron.plugin.onMenuItemsChanged((payload) => {
      pushReceived = true;
      sync(payload.items);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [location]);

  return items;
}

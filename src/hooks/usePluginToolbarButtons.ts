import { useState, useEffect } from "react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import { useToolbarPreferencesStore } from "@/store";
import { logWarn } from "@/utils/logger";

export interface PluginToolbarButtonState {
  buttonIds: PluginToolbarButtonId[];
  configs: Map<string, ToolbarButtonConfig>;
  isRegistered: (id: string) => boolean;
}

/**
 * Pull plugin-contributed toolbar buttons on mount and keep them in sync with
 * main's authoritative set via push. Pull-on-mount is a safety net for cached
 * `WebContentsView`s that may have missed a broadcast; push is authoritative —
 * once a push arrives, a later-resolving mount-time pull is dropped to avoid
 * rolling back state (mirrors `usePluginPanelKinds`).
 *
 * Stale `plugin.` entries in the `toolbarPreferencesStore` `pinnedButtons`
 * map (renderer-local persisted state, no main-process access) are pruned
 * here off the lifecycle snapshot — but ONLY off an authoritative one. The
 * pull and load-time pushes are partial/growing (plugins load concurrently
 * and `initialize()` is deferred), so sweeping against them would wipe a
 * not-yet-loaded plugin's hide preference. Only a `complete` push (a plugin
 * unload — i.e. uninstall, the exact case the sweep exists for) is swept.
 */
export function usePluginToolbarButtons(): PluginToolbarButtonState {
  const [configs, setConfigs] = useState<Map<string, ToolbarButtonConfig>>(new Map());

  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const sync = (buttons: ToolbarButtonConfig[], complete: boolean): void => {
      if (disposed) return;
      const map = new Map<string, ToolbarButtonConfig>();
      for (const btn of buttons) {
        map.set(btn.id, btn);
      }
      setConfigs(map);
      if (complete) {
        useToolbarPreferencesStore.getState().sweepStalePluginPinnedButtons(Array.from(map.keys()));
      }
    };

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .toolbarButtons()
      .then((buttons) => {
        if (disposed) return;
        if (pushReceived) return;
        // Pull is a display-only safety net: deferred `initialize()` means it
        // can resolve before all plugins have registered, so never sweep here.
        sync(buttons, false);
      })
      .catch((err: unknown) => {
        logWarn("[PluginToolbarButtons] Failed to fetch initial plugin toolbar buttons", {
          error: err,
        });
      });

    const cleanup = electron.plugin.onToolbarButtonsChanged((payload) => {
      pushReceived = true;
      sync(payload.buttons, payload.complete);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const buttonIds = Array.from(configs.keys()) as PluginToolbarButtonId[];
  const isRegistered = (id: string) => id.startsWith("plugin.") && configs.has(id);

  return { buttonIds, configs, isRegistered };
}

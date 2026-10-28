import { useState, useEffect, useMemo } from "react";
import { evaluateWhenClause } from "@shared/utils/whenClause";
import { useChromeWhenContext } from "@/hooks/useChromeWhenContext";
import { isRemoteContributionActionAllowed } from "@shared/utils/remotePluginContributions";
import { pluginViewHostId } from "@/components/Plugin/remotePluginView";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import { useToolbarPreferencesStore } from "@/store";
import { logWarn } from "@/utils/logger";
import { usePluginToolbarBadgeStore } from "@/store/pluginToolbarBadgeStore";
import { usePluginToolbarStateStore } from "@/store/pluginToolbarStateStore";
import { usePluginToolbarPopoverStore } from "@/store/pluginToolbarPopoverStore";

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
 * Stale plugin entries in the `toolbarPreferencesStore` `pinnedButtons` map
 * (renderer-local persisted state, no main-process access) are pruned here
 * off the lifecycle snapshot — but ONLY off an authoritative one. The pull
 * and load-time pushes are partial/growing (plugins load concurrently and
 * `initialize()` is deferred), so sweeping against them would wipe a
 * not-yet-loaded plugin's hide preference. Only a `complete` push (a plugin
 * unload — i.e. uninstall, the exact case the sweep exists for) is swept.
 *
 * #9281 retired the `plugin.{pluginId}.{btn}` prefix in favour of canonical
 * `{pluginId}.{btn}`. Stale entries from the old form are renamed by the v9
 * persistence migration so user pin preferences survive the rename.
 */
export function usePluginToolbarButtons(): PluginToolbarButtonState {
  const [configs, setConfigs] = useState<Map<string, ToolbarButtonConfig>>(new Map());

  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const sync = (buttons: ToolbarButtonConfig[], complete: boolean): void => {
      if (disposed) return;
      const map = new Map<string, ToolbarButtonConfig>();
      const remote = pluginViewHostId() !== null;
      for (const btn of buttons) {
        // A popover button names a view, not an action; the popover only mounts
        // a panel kind its own plugin registered, which is that button's check.
        if (
          remote &&
          btn.actionId !== undefined &&
          !isRemoteContributionActionAllowed(btn.pluginId, btn.actionId)
        ) {
          continue;
        }
        map.set(btn.id, btn);
      }
      setConfigs(map);
      // A popover whose button went away (its plugin unloaded or stopped
      // showing in this project) closes with it.
      usePluginToolbarPopoverStore.getState().retain(new Set(map.keys()));
      if (complete) {
        useToolbarPreferencesStore.getState().sweepStalePluginPinnedButtons(Array.from(map.keys()));
      }
    };

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;
    // The buttons' live badges and state, subscribed alongside the buttons themselves.
    usePluginToolbarBadgeStore.getState().init();
    usePluginToolbarStateStore.getState().init();

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
  // The broadcast `configs` map only contains plugin buttons received from
  // main, so set membership alone is the registered-plugin-button predicate —
  // no prefix string check needed (#9281).
  const isRegistered = (id: string) => configs.has(id);

  return { buttonIds, configs, isRegistered };
}

/**
 * The plugin toolbar buttons whose manifest `when` holds right now — what the
 * toolbar and its tray show. A hidden button only leaves this view: its config,
 * its pin and its saved slot in the layout stay where they are, so it returns
 * to the same place once the clause is true again. Settings and the stale-pin
 * sweep keep reading the full set from {@link usePluginToolbarButtons}.
 */
export function useVisiblePluginToolbarButtons(): PluginToolbarButtonState {
  const all = usePluginToolbarButtons();
  const context = useChromeWhenContext();
  const { configs } = all;

  const shown = useMemo(() => {
    let hidden = false;
    const visible = new Map<string, ToolbarButtonConfig>();
    for (const [id, config] of configs) {
      if (evaluateWhenClause(config.when, context)) visible.set(id, config);
      else hidden = true;
    }
    if (!hidden) return all;
    return {
      buttonIds: all.buttonIds.filter((id) => visible.has(id)),
      configs: visible,
      isRegistered: (id: string) => visible.has(id),
    };
  }, [all, configs, context]);

  // A popover whose button a false clause hid closes with it, as one whose
  // button went away does, rather than springing back open once it holds again.
  useEffect(() => {
    usePluginToolbarPopoverStore.getState().retain(new Set(shown.configs.keys()));
  }, [shown.configs]);

  return shown;
}

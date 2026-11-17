import { useEffect } from "react";
import { keybindingService } from "@/services/KeybindingService";
import { KEYBINDING_PRIORITY } from "@/services/defaultKeybindings";
import type { PluginKeybindingDescriptor } from "@shared/types/plugin";
import { isRemoteContributionActionAllowed } from "@shared/utils/remotePluginContributions";
import { isRetiredPluginKeybindingScope } from "@shared/config/pluginKeybindingScopes";
import { pluginViewHostId } from "@/components/Plugin/remotePluginView";

/**
 * Registers plugin-contributed keybindings into the KeybindingService.
 *
 * Pattern: pull-on-mount + push-authoritative (mirrors usePluginToolbarButtons).
 *
 * - On mount, pulls current plugin keybindings via `plugin.keybindings()`.
 * - Subscribes to `onKeybindingsChanged` for authoritative push updates.
 * - The push handler replaces the registered set; the pull only applies if no
 *   push has arrived yet (avoids clobbering a fresher push with a stale pull).
 *
 * A binding in a retired scope is skipped, never registered under another.
 *
 * Plugin bindings are registered at the PLUGIN priority tier (above built-in
 * defaults, below elevated built-ins and user overrides) and tagged with their
 * owning `pluginId` so unload can remove only that plugin's bindings without
 * disturbing built-in defaults that share an actionId.
 */
export function usePluginKeybindings(): void {
  useEffect(() => {
    let disposed = false;
    let pushReceived = false;
    const registeredPluginIds = new Set<string>();

    const electron = window.electron;
    if (!electron?.plugin) {
      return;
    }

    const apply = (entries: PluginKeybindingDescriptor[]) => {
      for (const pluginId of registeredPluginIds) {
        keybindingService.removePluginBindings(pluginId);
      }
      registeredPluginIds.clear();
      const remote = pluginViewHostId() !== null;
      for (const { pluginId, item } of entries) {
        if (remote && !isRemoteContributionActionAllowed(pluginId, item.actionId)) continue;
        // Main already drops retired scopes; a remote host on an older
        // release may still send them, and they never fire or move scope.
        const scope = item.scope ?? "global";
        if (isRetiredPluginKeybindingScope(scope)) continue;
        keybindingService.registerBinding({
          actionId: item.actionId,
          combo: item.combo,
          scope,
          priority: KEYBINDING_PRIORITY.PLUGIN,
          when: item.when,
          description: item.description,
          pluginId,
        });
        registeredPluginIds.add(pluginId);
      }
    };

    electron.plugin
      .keybindings()
      .then((entries) => {
        if (disposed || pushReceived) {
          return;
        }
        apply(entries ?? []);
      })
      .catch(() => {
        // Ignore pull errors; push will populate when available.
      });

    const unsubscribe = electron.plugin.onKeybindingsChanged?.((payload) => {
      pushReceived = true;
      if (disposed) {
        return;
      }
      apply(payload?.keybindings ?? []);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      for (const pluginId of registeredPluginIds) {
        keybindingService.removePluginBindings(pluginId);
      }
      registeredPluginIds.clear();
    };
  }, []);
}

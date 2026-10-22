import { useSyncExternalStore } from "react";
import type { PluginToolbarButtonRuntimeState } from "@shared/types/plugin";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import {
  getRegisteredPluginActionsSnapshot,
  subscribeToRegisteredPluginActions,
} from "@/services/plugin/registeredPluginActions";
import { usePluginToolbarButtonState } from "@/store/pluginToolbarStateStore";

export interface PluginToolbarMenuEntry {
  actionId: string;
  label: string;
}

const NO_ENTRIES: readonly PluginToolbarMenuEntry[] = [];

/**
 * The entries a plugin toolbar button's menu shows right now (#13786): the
 * plugin's live `menu` when it set one (an empty list removes the manifest's),
 * else the manifest's. An item waits for its action to register, as a panel's
 * menu does, and only the owning plugin's own actions are ever offered.
 */
export function resolvePluginToolbarMenu(
  config: Pick<ToolbarButtonConfig, "pluginId" | "menu">,
  state: Pick<PluginToolbarButtonRuntimeState, "menu"> | null,
  registeredPluginActions: ReadonlyMap<string, string>
): readonly PluginToolbarMenuEntry[] {
  const source = state?.menu ?? config.menu;
  if (!source || source.length === 0) return NO_ENTRIES;
  const ownPrefix = `${config.pluginId}.`;
  const entries: PluginToolbarMenuEntry[] = [];
  for (const item of source) {
    if (!item.actionId.startsWith(ownPrefix)) continue;
    const title = registeredPluginActions.get(item.actionId);
    if (title === undefined) continue;
    const label = item.label ?? title;
    if (label.length > 0) entries.push({ actionId: item.actionId, label });
  }
  return entries.length === 0 ? NO_ENTRIES : entries;
}

/** The live menu entries of one plugin toolbar button, following action registrations. */
export function usePluginToolbarMenu(
  config: Pick<ToolbarButtonConfig, "id" | "pluginId" | "menu">
): readonly PluginToolbarMenuEntry[] {
  const registered = useSyncExternalStore(
    subscribeToRegisteredPluginActions,
    getRegisteredPluginActionsSnapshot,
    getRegisteredPluginActionsSnapshot
  );
  return resolvePluginToolbarMenu(config, usePluginToolbarButtonState(config), registered);
}

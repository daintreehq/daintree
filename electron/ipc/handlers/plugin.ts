import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { pluginService } from "../../services/PluginService.js";
import {
  getPluginToolbarButtonIds,
  getToolbarButtonConfig,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { getPluginMenuItems } from "../../services/pluginMenuRegistry.js";
import { isTrustedRendererUrl } from "../../../shared/utils/trustedRenderer.js";
import type {
  LoadedPluginInfo,
  PluginIpcHandler,
  PluginIpcContext,
} from "../../../shared/types/plugin.js";
import type { ToolbarButtonConfig } from "../../../shared/config/toolbarButtonRegistry.js";
import { typedHandle } from "../utils.js";

let hasValidatedActionIds = false;

export function registerPluginHandlers(): () => void {
  const handlers: Array<() => void> = [];
  hasValidatedActionIds = false;

  const handleList = async (): Promise<LoadedPluginInfo[]> => {
    return pluginService.listPlugins();
  };

  const handleToolbarButtons = async (): Promise<ToolbarButtonConfig[]> => {
    return getPluginToolbarButtonIds()
      .map((id) => getToolbarButtonConfig(id))
      .filter((c): c is ToolbarButtonConfig => c !== undefined);
  };

  const handleMenuItems = async () => {
    return getPluginMenuItems();
  };

  const handleValidateActionIds = async (actionIds: string[]): Promise<void> => {
    if (hasValidatedActionIds) return;
    if (!Array.isArray(actionIds)) return;
    hasValidatedActionIds = true;

    const knownIds = new Set(actionIds.filter((id): id is string => typeof id === "string"));

    for (const id of getPluginToolbarButtonIds()) {
      const config = getToolbarButtonConfig(id);
      if (!config) continue;
      if (!knownIds.has(config.actionId)) {
        console.warn(
          `[Plugin] Unknown actionId "${config.actionId}" on toolbar button "${config.id}" (plugin: ${config.pluginId})`
        );
      }
    }

    for (const { pluginId, item } of getPluginMenuItems()) {
      if (!knownIds.has(item.actionId)) {
        console.warn(
          `[Plugin] Unknown actionId "${item.actionId}" on menu item "${item.label}" (plugin: ${pluginId})`
        );
      }
    }
  };

  handlers.push(typedHandle(CHANNELS.PLUGIN_LIST, handleList));

  // plugin:invoke intentionally stays on raw ipcMain.handle: its variadic
  // `...args: unknown[]` signature and senderFrame.url trust check can't be
  // expressed through IpcInvokeMap without widening types to `unknown[]`,
  // which would silently defeat the compile-time safety the migration is for.
  ipcMain.handle(
    CHANNELS.PLUGIN_INVOKE,
    async (event, pluginId: string, channel: string, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        throw new Error(`plugin:invoke rejected: untrusted sender (url=${senderUrl ?? "unknown"})`);
      }
      const ctx: PluginIpcContext = {
        projectId: null,
        worktreeId: null,
        webContentsId: event.sender.id,
        pluginId,
      };
      return await pluginService.dispatchHandler(pluginId, channel, ctx, args);
    }
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_INVOKE));

  handlers.push(typedHandle(CHANNELS.PLUGIN_TOOLBAR_BUTTONS, handleToolbarButtons));
  handlers.push(typedHandle(CHANNELS.PLUGIN_MENU_ITEMS, handleMenuItems));
  handlers.push(typedHandle(CHANNELS.PLUGIN_VALIDATE_ACTION_IDS, handleValidateActionIds));

  return () => handlers.forEach((cleanup) => cleanup());
}

export function registerPluginHandler(
  pluginId: string,
  channel: string,
  handler: PluginIpcHandler
): void {
  pluginService.registerHandler(pluginId, channel, handler);
}

export function removePluginHandlers(pluginId: string): void {
  pluginService.removeHandlers(pluginId);
}

import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { pluginService } from "../../services/PluginService.js";
import type { LoadedPluginInfo, PluginIpcHandler } from "../../../shared/types/plugin.js";

export function registerPluginHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleList = async (): Promise<LoadedPluginInfo[]> => {
    return pluginService.listPlugins();
  };

  ipcMain.handle(CHANNELS.PLUGIN_LIST, handleList);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_LIST));

  ipcMain.handle(
    CHANNELS.PLUGIN_INVOKE,
    async (_event, pluginId: string, channel: string, ...args: unknown[]) => {
      return await pluginService.dispatchHandler(pluginId, channel, args);
    }
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_INVOKE));

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

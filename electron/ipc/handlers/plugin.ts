import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { pluginService } from "../../services/PluginService.js";
import type { LoadedPluginInfo } from "../../../shared/types/plugin.js";

export function registerPluginHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleList = async (): Promise<LoadedPluginInfo[]> => {
    return pluginService.listPlugins();
  };

  ipcMain.handle(CHANNELS.PLUGIN_LIST, handleList);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_LIST));

  return () => handlers.forEach((cleanup) => cleanup());
}

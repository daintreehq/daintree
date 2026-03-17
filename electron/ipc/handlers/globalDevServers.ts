import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { GlobalDevServersChangedPayload } from "../../../shared/types/ipc/globalDevServers.js";
import { GlobalTerminalScannerService } from "../../services/GlobalTerminalScannerService.js";

export function registerGlobalDevServersHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const sendToRenderer = (channel: string, data: unknown) => {
    if (
      deps.mainWindow &&
      !deps.mainWindow.isDestroyed() &&
      !deps.mainWindow.webContents.isDestroyed()
    ) {
      try {
        deps.mainWindow.webContents.send(channel, data);
      } catch {
        // Ignore send failures during window disposal.
      }
    }
  };

  const service = new GlobalTerminalScannerService(deps.ptyClient!);
  service.onChanged((servers) => {
    const payload: GlobalDevServersChangedPayload = { servers };
    sendToRenderer(CHANNELS.GLOBAL_DEV_SERVERS_CHANGED, payload);
  });

  ipcMain.handle(CHANNELS.GLOBAL_DEV_SERVERS_GET, () => {
    return { servers: service.getAll() };
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GLOBAL_DEV_SERVERS_GET));

  return () => {
    service.dispose();
    handlers.forEach((dispose) => dispose());
  };
}

import { ipcMain, dialog } from "electron";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { collectDiagnostics } from "../../services/DiagnosticsCollector.js";

export function registerDiagnosticsHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleDownloadDiagnostics = async (): Promise<boolean> => {
    const payload = await collectDiagnostics(deps);
    const json = JSON.stringify(payload, null, 2);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const { filePath, canceled } = await dialog.showSaveDialog(deps.mainWindow, {
      title: "Save Diagnostics",
      defaultPath: `canopy-diagnostics-${timestamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (canceled || !filePath) return false;

    await fs.writeFile(filePath, json, "utf-8");
    return true;
  };
  ipcMain.handle(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS, handleDownloadDiagnostics);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS));

  return () => handlers.forEach((cleanup) => cleanup());
}

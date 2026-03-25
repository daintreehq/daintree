import { app, ipcMain, dialog } from "electron";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { AppMetricsSummary } from "../../../shared/types/ipc/system.js";
import { collectDiagnostics } from "../../services/DiagnosticsCollector.js";

export function registerDiagnosticsHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetAppMetrics = (): AppMetricsSummary => {
    try {
      const metrics = app.getAppMetrics();
      let totalKB = 0;
      for (const proc of metrics) {
        totalKB += proc.memory.privateBytes ?? proc.memory.workingSetSize;
      }
      return { totalMemoryMB: Math.round(totalKB / 1024) };
    } catch {
      return { totalMemoryMB: 0 };
    }
  };
  ipcMain.handle(CHANNELS.SYSTEM_GET_APP_METRICS, handleGetAppMetrics);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_GET_APP_METRICS));

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

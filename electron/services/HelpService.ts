// eager-import-allow: reads bundled help content via sync fs at module scope
import fs from "fs";
import path from "path";
import { app } from "electron";

let cachedHelpFolderPath: string | null | undefined = undefined;

export function getHelpFolderPath(): string | null {
  if (cachedHelpFolderPath !== undefined) {
    return cachedHelpFolderPath;
  }

  const folderPath = app.isPackaged
    ? path.join(process.resourcesPath, "help")
    : path.join(app.getAppPath(), "help");

  if (!fs.existsSync(folderPath)) {
    console.warn(`[HelpService] Help folder not found: ${folderPath} (packaged=${app.isPackaged})`);
    cachedHelpFolderPath = null;
    return null;
  }

  cachedHelpFolderPath = folderPath;
  return folderPath;
}

import fs from "fs";
import path from "path";
import { app } from "electron";

export function getHelpFolderPath(): string | null {
  const folderPath = app.isPackaged
    ? path.join(process.resourcesPath, "help")
    : path.join(app.getAppPath(), "help");

  if (!fs.existsSync(folderPath)) {
    console.warn(`[HelpService] Help folder not found: ${folderPath}`);
    return null;
  }

  return folderPath;
}

import { ipcMain, dialog, BrowserWindow } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseColorSchemeFile } from "../../utils/colorSchemeImporter.js";
import type { AppThemeConfig } from "../../../shared/types/appTheme.js";

function getAppThemeConfig(): AppThemeConfig {
  const config = store.get("appTheme");
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as AppThemeConfig;
  }
  return { colorSchemeId: "canopy" };
}

export function registerAppThemeHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleAppThemeGet = async () => {
    return getAppThemeConfig();
  };
  ipcMain.handle(CHANNELS.APP_THEME_GET, handleAppThemeGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_THEME_GET));

  const handleAppThemeSetColorScheme = async (
    _event: Electron.IpcMainInvokeEvent,
    schemeId: string
  ) => {
    if (typeof schemeId !== "string" || !schemeId.trim()) {
      console.warn("Invalid app theme colorSchemeId:", schemeId);
      return;
    }
    const current = getAppThemeConfig();
    store.set("appTheme", { ...current, colorSchemeId: schemeId.trim() } satisfies AppThemeConfig);
  };
  ipcMain.handle(CHANNELS.APP_THEME_SET_COLOR_SCHEME, handleAppThemeSetColorScheme);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_THEME_SET_COLOR_SCHEME));

  const handleAppThemeSetCustomSchemes = async (
    _event: Electron.IpcMainInvokeEvent,
    schemesJson: string
  ) => {
    if (typeof schemesJson !== "string") {
      console.warn("Invalid app custom schemes:", schemesJson);
      return;
    }
    const current = getAppThemeConfig();
    store.set("appTheme", {
      ...current,
      customSchemes: schemesJson,
    } satisfies AppThemeConfig);
  };
  ipcMain.handle(CHANNELS.APP_THEME_SET_CUSTOM_SCHEMES, handleAppThemeSetCustomSchemes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_THEME_SET_CUSTOM_SCHEMES));

  const handleAppThemeImport = async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const dialogOptions = {
      title: "Import App Theme",
      filters: [
        { name: "Theme Files", extensions: ["json"] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile" as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, errors: ["Import cancelled"] };
    }

    return parseColorSchemeFile(result.filePaths[0]);
  };
  ipcMain.handle(CHANNELS.APP_THEME_IMPORT, handleAppThemeImport);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_THEME_IMPORT));

  return () => handlers.forEach((cleanup) => cleanup());
}

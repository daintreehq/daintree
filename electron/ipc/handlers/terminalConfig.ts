import { ipcMain, dialog, BrowserWindow } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseColorSchemeFile } from "../../utils/colorSchemeImporter.js";
import type { HandlerDependencies } from "../types.js";

function getTerminalConfigObject(): Record<string, unknown> {
  const config = store.get("terminalConfig");
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

export function registerTerminalConfigHandlers(deps?: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleTerminalConfigGet = async () => {
    return getTerminalConfigObject();
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_GET, handleTerminalConfigGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_GET));

  const handleTerminalConfigSetScrollback = async (
    _event: Electron.IpcMainInvokeEvent,
    scrollbackLines: number
  ) => {
    if (!Number.isFinite(scrollbackLines) || !Number.isInteger(scrollbackLines)) {
      const error = `Invalid scrollback value (not a finite integer): ${scrollbackLines}`;
      console.warn(error);
      throw new Error(error);
    }
    if (scrollbackLines < 100 || scrollbackLines > 10000) {
      const error = `Invalid scrollback value (out of range 100-10000): ${scrollbackLines}`;
      console.warn(error);
      throw new Error(error);
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, scrollbackLines });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK, handleTerminalConfigSetScrollback);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK));

  const handleTerminalConfigSetPerformanceMode = async (
    _event: Electron.IpcMainInvokeEvent,
    performanceMode: boolean
  ) => {
    if (typeof performanceMode !== "boolean") {
      console.warn("Invalid terminal performanceMode:", performanceMode);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, performanceMode });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE,
    handleTerminalConfigSetPerformanceMode
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE));

  const handleTerminalConfigSetFontSize = async (
    _event: Electron.IpcMainInvokeEvent,
    fontSize: number
  ) => {
    if (!Number.isFinite(fontSize) || !Number.isInteger(fontSize)) {
      console.warn("Invalid terminal fontSize (not a finite integer):", fontSize);
      return;
    }
    if (fontSize < 8 || fontSize > 24) {
      console.warn("Invalid terminal fontSize (out of range 8-24):", fontSize);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, fontSize });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE, handleTerminalConfigSetFontSize);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE));

  const handleTerminalConfigSetFontFamily = async (
    _event: Electron.IpcMainInvokeEvent,
    fontFamily: string
  ) => {
    if (typeof fontFamily !== "string" || !fontFamily.trim()) {
      console.warn("Invalid terminal fontFamily:", fontFamily);
      return;
    }
    const trimmedFontFamily = fontFamily.trim();
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, fontFamily: trimmedFontFamily });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY, handleTerminalConfigSetFontFamily);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY));

  const handleTerminalConfigSetHybridInputEnabled = async (
    _event: Electron.IpcMainInvokeEvent,
    enabled: boolean
  ) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal hybridInputEnabled:", enabled);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, hybridInputEnabled: enabled });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED,
    handleTerminalConfigSetHybridInputEnabled
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED));

  const handleTerminalConfigSetHybridInputAutoFocus = async (
    _event: Electron.IpcMainInvokeEvent,
    enabled: boolean
  ) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal hybridInputAutoFocus:", enabled);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, hybridInputAutoFocus: enabled });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS,
    handleTerminalConfigSetHybridInputAutoFocus
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS));

  const handleTerminalConfigSetColorScheme = async (
    _event: Electron.IpcMainInvokeEvent,
    schemeId: string
  ) => {
    if (typeof schemeId !== "string" || !schemeId.trim()) {
      console.warn("Invalid terminal colorScheme:", schemeId);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, colorSchemeId: schemeId.trim() });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_COLOR_SCHEME, handleTerminalConfigSetColorScheme);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_COLOR_SCHEME));

  const handleTerminalConfigSetCustomSchemes = async (
    _event: Electron.IpcMainInvokeEvent,
    schemesJson: string
  ) => {
    if (typeof schemesJson !== "string") {
      console.warn("Invalid custom schemes:", schemesJson);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, customSchemes: schemesJson });
  };
  ipcMain.handle(CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES, handleTerminalConfigSetCustomSchemes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES));

  const handleTerminalConfigSetScreenReaderMode = async (
    _event: Electron.IpcMainInvokeEvent,
    mode: string
  ) => {
    if (mode !== "auto" && mode !== "on" && mode !== "off") {
      console.warn("Invalid screen reader mode:", mode);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, screenReaderMode: mode });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE,
    handleTerminalConfigSetScreenReaderMode
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE));

  const handleTerminalConfigSetResourceMonitoring = async (
    _event: Electron.IpcMainInvokeEvent,
    enabled: boolean
  ) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal resourceMonitoringEnabled:", enabled);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, resourceMonitoringEnabled: enabled });
    deps?.ptyClient?.setResourceMonitoring(enabled);
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_RESOURCE_MONITORING,
    handleTerminalConfigSetResourceMonitoring
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_RESOURCE_MONITORING));

  const handleTerminalConfigSetMemoryLeakDetection = async (
    _event: Electron.IpcMainInvokeEvent,
    enabled: boolean
  ) => {
    if (typeof enabled !== "boolean") {
      console.warn("Invalid terminal memoryLeakDetectionEnabled:", enabled);
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", { ...currentConfig, memoryLeakDetectionEnabled: enabled });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION,
    handleTerminalConfigSetMemoryLeakDetection
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION));

  const handleTerminalConfigSetMemoryLeakAutoRestart = async (
    _event: Electron.IpcMainInvokeEvent,
    thresholdMb: number
  ) => {
    if (!Number.isFinite(thresholdMb) || !Number.isInteger(thresholdMb)) {
      console.warn("Invalid memoryLeakAutoRestartThresholdMb (not a finite integer):", thresholdMb);
      return;
    }
    if (thresholdMb < 1024 || thresholdMb > 32768) {
      console.warn(
        "Invalid memoryLeakAutoRestartThresholdMb (out of range 1024-32768):",
        thresholdMb
      );
      return;
    }
    const currentConfig = getTerminalConfigObject();
    store.set("terminalConfig", {
      ...currentConfig,
      memoryLeakAutoRestartThresholdMb: thresholdMb,
    });
  };
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART,
    handleTerminalConfigSetMemoryLeakAutoRestart
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART));

  const handleTerminalConfigImportColorScheme = async (event: Electron.IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const dialogOptions = {
      title: "Import Color Scheme",
      filters: [
        { name: "Color Schemes", extensions: ["itermcolors", "json"] },
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
  ipcMain.handle(
    CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME,
    handleTerminalConfigImportColorScheme
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME));

  return () => handlers.forEach((cleanup) => cleanup());
}

import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";

function getTerminalConfigObject(): Record<string, unknown> {
  const config = store.get("terminalConfig");
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

export function registerTerminalConfigHandlers(): () => void {
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

  return () => handlers.forEach((cleanup) => cleanup());
}

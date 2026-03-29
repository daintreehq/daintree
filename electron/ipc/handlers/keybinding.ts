import { ipcMain, dialog } from "electron";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { KeyAction } from "../../../shared/types/keymap.js";
import { exportProfile, importProfile } from "../../utils/keybindingProfileIO.js";
import type { ImportResult } from "../../utils/keybindingProfileIO.js";

function getValidatedOverrides(): Record<string, string[]> {
  const raw = store.get("keybindingOverrides.overrides");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const validated: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.every((c) => typeof c === "string" && c.trim() !== "")) {
      validated[key] = value;
    }
  }
  return validated;
}

export function registerKeybindingHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetOverrides = async () => {
    return getValidatedOverrides();
  };
  ipcMain.handle(CHANNELS.KEYBINDING_GET_OVERRIDES, handleGetOverrides);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.KEYBINDING_GET_OVERRIDES));

  const handleSetOverride = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { actionId: KeyAction; combo: string[] }
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid keybinding override payload");
    }

    const { actionId, combo } = payload;

    if (typeof actionId !== "string" || actionId.trim() === "") {
      throw new Error("Invalid actionId: must be non-empty string");
    }

    if (!Array.isArray(combo)) {
      throw new Error("Invalid combo: must be an array");
    }

    if (combo.length > 0 && combo.some((c) => typeof c !== "string" || c.trim() === "")) {
      throw new Error("Invalid combo: array contains non-string or empty values");
    }

    const overrides = getValidatedOverrides();
    overrides[actionId] = combo;
    store.set("keybindingOverrides.overrides", overrides);
  };
  ipcMain.handle(CHANNELS.KEYBINDING_SET_OVERRIDE, handleSetOverride);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.KEYBINDING_SET_OVERRIDE));

  const handleRemoveOverride = async (_event: Electron.IpcMainInvokeEvent, actionId: KeyAction) => {
    if (typeof actionId !== "string" || actionId.trim() === "") {
      throw new Error("Invalid actionId for remove");
    }

    const overrides = getValidatedOverrides();
    delete overrides[actionId];
    store.set("keybindingOverrides.overrides", overrides);
  };
  ipcMain.handle(CHANNELS.KEYBINDING_REMOVE_OVERRIDE, handleRemoveOverride);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.KEYBINDING_REMOVE_OVERRIDE));

  const handleResetAll = async () => {
    store.set("keybindingOverrides.overrides", {});
  };
  ipcMain.handle(CHANNELS.KEYBINDING_RESET_ALL, handleResetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.KEYBINDING_RESET_ALL));

  const handleExportProfile = async (): Promise<boolean> => {
    const overrides = getValidatedOverrides();
    const json = exportProfile(overrides);

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: "Export Keyboard Shortcuts",
      defaultPath: "canopy-keybindings.json",
      filters: [{ name: "Keybinding Profile", extensions: ["json"] }],
    });

    if (canceled || !filePath) return false;

    await fs.writeFile(filePath, json, "utf-8");
    return true;
  };
  ipcMain.handle(CHANNELS.KEYBINDING_EXPORT_PROFILE, handleExportProfile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.KEYBINDING_EXPORT_PROFILE));

  const handleImportProfile = async (): Promise<ImportResult> => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: "Import Keyboard Shortcuts",
      filters: [{ name: "Keybinding Profile", extensions: ["json"] }],
      properties: ["openFile"],
    });

    if (canceled || filePaths.length === 0) {
      return { ok: false, overrides: {}, applied: 0, skipped: 0, errors: ["Cancelled"] };
    }

    const json = await fs.readFile(filePaths[0], "utf-8");
    const result = importProfile(json);

    if (result.ok) {
      const existing = getValidatedOverrides();
      const merged = { ...existing, ...result.overrides };
      store.set("keybindingOverrides.overrides", merged);
    }

    return result;
  };
  ipcMain.handle(CHANNELS.KEYBINDING_IMPORT_PROFILE, handleImportProfile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.KEYBINDING_IMPORT_PROFILE));

  return () => handlers.forEach((cleanup) => cleanup());
}

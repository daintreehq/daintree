import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies } from "../types.js";

export function registerEditorConfigHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleEditorGetConfig = async (_event: Electron.IpcMainInvokeEvent, projectId: unknown) => {
    const { discover } = await import("../../services/EditorService.js");
    const discoveredEditors = discover();

    let preferredEditor = null;
    if (typeof projectId === "string" && projectId) {
      try {
        const settings = await projectStore.getProjectSettings(projectId);
        preferredEditor = settings.preferredEditor ?? null;
      } catch {
        // return null preference on error
      }
    }

    return { preferredEditor, discoveredEditors };
  };
  ipcMain.handle(CHANNELS.EDITOR_GET_CONFIG, handleEditorGetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EDITOR_GET_CONFIG));

  const handleEditorSetConfig = async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { editor, projectId } = payload as { editor: unknown; projectId?: unknown };

    if (!editor || typeof editor !== "object") {
      throw new Error("Invalid editor config");
    }
    const editorObj = editor as Record<string, unknown>;
    const validIds = [
      "vscode",
      "vscode-insiders",
      "cursor",
      "windsurf",
      "zed",
      "neovim",
      "webstorm",
      "sublime",
      "custom",
    ];
    if (typeof editorObj.id !== "string" || !validIds.includes(editorObj.id)) {
      throw new Error(`Invalid editor id: ${String(editorObj.id)}`);
    }
    if (editorObj.customCommand !== undefined) {
      if (typeof editorObj.customCommand !== "string" || editorObj.customCommand.length > 512) {
        throw new Error("Invalid customCommand");
      }
    }
    if (editorObj.customTemplate !== undefined) {
      if (typeof editorObj.customTemplate !== "string" || editorObj.customTemplate.length > 512) {
        throw new Error("Invalid customTemplate");
      }
    }

    const isCustom = editorObj.id === "custom";
    if (isCustom) {
      const cmd = typeof editorObj.customCommand === "string" ? editorObj.customCommand.trim() : "";
      if (!cmd) {
        throw new Error("Invalid customCommand: must be non-empty for custom editor");
      }
    }

    const editorConfig = {
      id: editorObj.id as import("../../../shared/types/editor.js").KnownEditorId,
      customCommand:
        isCustom && typeof editorObj.customCommand === "string"
          ? editorObj.customCommand
          : undefined,
      customTemplate:
        isCustom && typeof editorObj.customTemplate === "string"
          ? editorObj.customTemplate
          : undefined,
    };

    const pid = typeof projectId === "string" ? projectId : null;
    if (!pid) {
      throw new Error("projectId is required");
    }

    const settings = await projectStore.getProjectSettings(pid);
    await projectStore.saveProjectSettings(pid, { ...settings, preferredEditor: editorConfig });
  };
  ipcMain.handle(CHANNELS.EDITOR_SET_CONFIG, handleEditorSetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EDITOR_SET_CONFIG));

  const handleEditorDiscover = async () => {
    const { discover } = await import("../../services/EditorService.js");
    return discover();
  };
  ipcMain.handle(CHANNELS.EDITOR_DISCOVER, handleEditorDiscover);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EDITOR_DISCOVER));

  return () => handlers.forEach((cleanup) => cleanup());
}

import type {
  EditorConfig,
  EditorGetConfigResult,
  EditorSetConfigPayload,
  DiscoveredEditor,
} from "@shared/types/editor";

export const editorClient = {
  getConfig: (projectId?: string): Promise<EditorGetConfigResult> => {
    return window.electron.editor.getConfig(projectId);
  },

  setConfig: (payload: EditorSetConfigPayload): Promise<void> => {
    return window.electron.editor.setConfig(payload);
  },

  discover: (): Promise<DiscoveredEditor[]> => {
    return window.electron.editor.discover();
  },
} as const;

export type { EditorConfig, EditorGetConfigResult, EditorSetConfigPayload, DiscoveredEditor };

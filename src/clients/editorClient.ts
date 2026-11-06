import type {
  EditorConfig,
  EditorGetConfigResult,
  EditorSetConfigPayload,
  EditorSetDefaultPayload,
  EditorClearProjectPreferencePayload,
  DiscoveredEditor,
} from "@shared/types/editor";

export const editorClient = {
  getConfig: (projectId?: string): Promise<EditorGetConfigResult> => {
    return window.electron.editor.getConfig(projectId);
  },

  setConfig: (payload: EditorSetConfigPayload): Promise<void> => {
    return window.electron.editor.setConfig(payload);
  },

  setDefault: (payload: EditorSetDefaultPayload): Promise<void> => {
    return window.electron.editor.setDefault(payload);
  },

  clearProjectPreference: (payload: EditorClearProjectPreferencePayload): Promise<void> => {
    return window.electron.editor.clearProjectPreference(payload);
  },

  discover: (): Promise<DiscoveredEditor[]> => {
    return window.electron.editor.discover();
  },
} as const;

export type {
  EditorConfig,
  EditorGetConfigResult,
  EditorSetConfigPayload,
  EditorSetDefaultPayload,
  EditorClearProjectPreferencePayload,
  DiscoveredEditor,
};

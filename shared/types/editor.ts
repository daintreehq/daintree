export type KnownEditorId =
  | "vscode"
  | "vscode-insiders"
  | "cursor"
  | "windsurf"
  | "zed"
  | "neovim"
  | "webstorm"
  | "sublime"
  | "custom";

/** Persisted preference for the user's chosen editor */
export interface EditorConfig {
  id: KnownEditorId;
  /** Only used when id === "custom" */
  customCommand?: string;
  /** Template for custom editors: use {file}, {line}, {col} placeholders */
  customTemplate?: string;
}

/** Result of PATH/Toolbox discovery for one editor */
export interface DiscoveredEditor {
  id: KnownEditorId;
  name: string;
  available: boolean;
  executablePath?: string;
}

/** Payload for editor:set-config IPC */
export interface EditorSetConfigPayload {
  editor: EditorConfig;
  projectId?: string;
}

/** Result of editor:get-config IPC */
export interface EditorGetConfigResult {
  preferredEditor: EditorConfig | null;
  discoveredEditors: DiscoveredEditor[];
}

/**
 * Every selectable editor id, in picker display order. The single source of truth:
 * the union, the `setConfig` allowlist, and the picker's ordering all derive from
 * it, so a new editor cannot compile into one list and be missing from another.
 */
export const KNOWN_EDITOR_IDS = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "antigravity-ide",
  "zed",
  "neovim",
  "webstorm",
  "sublime",
  "custom",
] as const;

export type KnownEditorId = (typeof KNOWN_EDITOR_IDS)[number];

export function isKnownEditorId(value: unknown): value is KnownEditorId {
  return typeof value === "string" && (KNOWN_EDITOR_IDS as readonly string[]).includes(value);
}

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

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

/** Payload for editor:set-default IPC: the fallback for projects with no saved editor */
export interface EditorSetDefaultPayload {
  editor: EditorConfig;
}

/** Payload for editor:clear-project-preference IPC */
export interface EditorClearProjectPreferencePayload {
  projectId: string;
}

/** Result of editor:get-config IPC */
export interface EditorGetConfigResult {
  /** The project's own saved editor; null when the project uses the fallback */
  preferredEditor: EditorConfig | null;
  /** The default on the machine that launches the editor; null when none is set */
  defaultEditor: EditorConfig | null;
  /** `preferredEditor ?? defaultEditor`; null means automatic selection */
  effectiveEditor: EditorConfig | null;
  discoveredEditors: DiscoveredEditor[];
}

/** The editor a launch tries first: the project's own choice, else the stored default. */
export function resolveEffectiveEditor(
  preferredEditor: EditorConfig | null,
  defaultEditor: EditorConfig | null
): EditorConfig | null {
  return preferredEditor ?? defaultEditor;
}

const EDITOR_FIELD_MAX_LENGTH = 512;

/**
 * The one validation for an editor choice, whether it is saved for a project or
 * as the default. Throws on anything that isn't a launchable config, and drops
 * the custom fields from a known editor.
 */
export function normalizeEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid editor config");
  }
  const editorObj = value as Record<string, unknown>;
  if (!isKnownEditorId(editorObj.id)) {
    throw new Error(`Invalid editor id: ${String(editorObj.id)}`);
  }
  if (editorObj.customCommand !== undefined) {
    if (
      typeof editorObj.customCommand !== "string" ||
      editorObj.customCommand.length > EDITOR_FIELD_MAX_LENGTH
    ) {
      throw new Error("Invalid customCommand");
    }
  }
  if (editorObj.customTemplate !== undefined) {
    if (
      typeof editorObj.customTemplate !== "string" ||
      editorObj.customTemplate.length > EDITOR_FIELD_MAX_LENGTH
    ) {
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

  return {
    id: editorObj.id,
    customCommand:
      isCustom && typeof editorObj.customCommand === "string" ? editorObj.customCommand : undefined,
    customTemplate:
      isCustom && typeof editorObj.customTemplate === "string"
        ? editorObj.customTemplate
        : undefined,
  };
}

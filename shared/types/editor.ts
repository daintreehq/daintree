/**
 * The JetBrains IDEs, each its own choice, in the order a saved
 * `LEGACY_JETBRAINS_EDITOR_ID` searches their launchers.
 */
export const JETBRAINS_EDITOR_IDS = [
  "jetbrains-webstorm",
  "jetbrains-idea",
  "jetbrains-phpstorm",
  "jetbrains-pycharm",
  "jetbrains-goland",
  "jetbrains-rider",
  "jetbrains-clion",
  "jetbrains-datagrip",
  "jetbrains-rubymine",
] as const;

export type JetBrainsEditorId = (typeof JETBRAINS_EDITOR_IDS)[number];

/**
 * Saved before each JetBrains IDE had its own id, when one entry stood for all of
 * them: it opens whichever is found first. Still read and launched as it always
 * was, but the picker offers it only while it is the saved choice.
 */
export const LEGACY_JETBRAINS_EDITOR_ID = "webstorm";

/**
 * Every editor id a config can hold, in picker display order. The single source of
 * truth: the union, the `setConfig` allowlist, and the picker's ordering all derive
 * from it, so a new editor cannot compile into one list and be missing from another.
 */
export const KNOWN_EDITOR_IDS = [
  "vscode",
  "vscode-insiders",
  "cursor",
  "windsurf",
  "antigravity-ide",
  "zed",
  "neovim",
  LEGACY_JETBRAINS_EDITOR_ID,
  ...JETBRAINS_EDITOR_IDS,
  "sublime",
  "custom",
] as const;

export type KnownEditorId = (typeof KNOWN_EDITOR_IDS)[number];

export function isKnownEditorId(value: unknown): value is KnownEditorId {
  return typeof value === "string" && (KNOWN_EDITOR_IDS as readonly string[]).includes(value);
}

/**
 * Editors that only run inside a terminal, with the program a terminal app
 * would run for each. Every launch is detached with its streams ignored, so one
 * of these would start as a process nobody can see (#17441): automatic
 * selection passes over them, and choosing one explains how to run it through a
 * terminal app instead.
 */
const TERMINAL_ONLY_EDITOR_COMMANDS: ReadonlyMap<KnownEditorId, string> = new Map([
  ["neovim", "nvim"],
]);

/**
 * The program to run in a terminal app, or undefined for an editor that opens
 * its own window. A Map, so an id read from a settings file can never resolve
 * to an inherited object member.
 */
export function terminalOnlyEditorCommand(id: KnownEditorId): string | undefined {
  return TERMINAL_ONLY_EDITOR_COMMANDS.get(id);
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

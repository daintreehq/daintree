/** Default byte ceiling when a `contributes.fileEditors` entry omits `maxBytes`. */
export const DEFAULT_FILE_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One `contributes.fileEditors` entry (#12323, #13809): an editor the host
 * file panel offers for matching files. Exactly one of `slot` / `view`.
 *
 * A **view-backed** editor names one of the plugin's own `location:
 * "fileEditor"` views. `mode: "edit"` fills the file panel's Edit mode;
 * `mode: "view"` fills Rendered for a type the host cannot render itself. The
 * view receives a host-owned document as {@link PanelViewProps.fileDocument}.
 * Any plugin may declare one; the mode is labelled with the plugin's name, and
 * when several editors match the user picks with "Edit with…", remembered per
 * project.
 *
 * A **slot-backed** editor names a builtin view id the plugin's renderer entry
 * registers with `registerBuiltinView`. Built-in plugins only: that registry
 * is compiled into the host bundle, which no other plugin's renderer reaches.
 *
 * Matching is by `extensions` and, for a `"scope": "project"` plugin only, by
 * `paths` — globs relative to the project or worktree root.
 */
export interface FileEditorContribution {
  /** Namespaced at runtime as `{pluginId}.{id}`. */
  id: string;
  /** Builtin view id the plugin's renderer registers for the editor surface. Built-in plugins only. */
  slot?: string;
  /** Id of one of this plugin's `location: "fileEditor"` views. */
  view?: string;
  /** What a view-backed editor fills: the Edit mode, or Rendered for a type the host can't render. */
  mode?: FileEditorMode;
  /** Lower-case extensions without the dot (`["md", "markdown"]`), matched case-insensitively. */
  extensions?: string[];
  /** Project-relative globs, such as `content/entries/*.json`. Project plugins only. */
  paths?: string[];
  /**
   * Make this editor what a file matching one of `paths` opens in (#13811):
   * each pattern becomes a file editor slot in the project, arbitrated, asked
   * about and reset like any other slot. A project plugin's `mode: "edit"`
   * editor only, and never by extension — Source stays in the mode toggle.
   */
  default?: boolean;
  /** Largest file the editor accepts, in bytes. Absent means the host's default cap. */
  maxBytes?: number;
}

/** Which file panel mode a view-backed file editor fills. */
export type FileEditorMode = "edit" | "view";

/**
 * What an "Edit with…" answer is about (#13809): a mode and the file's
 * lower-case extension, or `*` for a file without one — `edit:csv`,
 * `view:*`. Remembered per project in Daintree's own settings.
 */
export type FileEditorChoiceKey = `${FileEditorMode}:${string}`;

/**
 * The editor an "Edit with…" answer picked: `"host"` for the host's own
 * (the built-in editor, or the host renderer for Rendered), else the plugin
 * editor's {@link fileEditorChoiceId}.
 */
export type FileEditorChoice = string;

/** One project's "Edit with…" answers. */
export type FileEditorChoices = Readonly<Record<FileEditorChoiceKey, FileEditorChoice>>;

/** The host's own editor or renderer, as an "Edit with…" answer. */
export const HOST_FILE_EDITOR_CHOICE = "host";

const FILE_EDITOR_CHOICE_KEY_PATTERN = /^(edit|view):([a-z0-9]{1,16}|\*)$/;

export function isFileEditorChoiceKey(value: unknown): value is FileEditorChoiceKey {
  return typeof value === "string" && FILE_EDITOR_CHOICE_KEY_PATTERN.test(value);
}

/**
 * A plugin file editor's stable identity as an answer: the plugin's runtime
 * instance key and the editor's bare id, so a project plugin and an installed
 * plugin sharing a manifest id stay distinct.
 */
export function fileEditorChoiceId(pluginId: string, editorId: string): FileEditorChoice {
  return `${pluginId}/${editorId}`;
}

export function isFileEditorChoice(value: unknown): value is FileEditorChoice {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    (value === HOST_FILE_EDITOR_CHOICE || /^[^/\0]+\/[a-zA-Z0-9._-]+$/.test(value))
  );
}

/** What {@link PluginFileDocument.read} found on disk. */
export type PluginFileDocumentReadResult =
  | {
      status: "ok";
      /** The file's text: a UTF-8 BOM stripped, line endings as `\n`. */
      text: string;
      /** Opaque token for these exact bytes; pass it back to `save`. */
      revision: string;
    }
  /** Gone, unreadable, or outside the project. */
  | { status: "unavailable" }
  /** Larger than the editor's `maxBytes`. */
  | { status: "too-large" }
  /** Not UTF-8 text. */
  | { status: "not-text" };

/** The outcome of {@link PluginFileDocument.save}. */
export type PluginFileDocumentSaveResult =
  | { status: "saved"; revision: string }
  /**
   * The file changed on disk since `expectedRevision`. Nothing was written,
   * and the document is marked as in conflict until a later save lands or the
   * draft is discarded. `revision` is what is on disk now, null when the file
   * is gone.
   */
  | { status: "conflict"; revision: string | null }
  | { status: "refused"; reason: "read-only" | "too-large" | "unavailable" }
  | { status: "error"; message: string };

/** Why a {@link PluginFileDocument} changed under the view. */
export interface PluginFileDocumentChange {
  /**
   * `"disk"`: the file changed on disk — re-read it, or keep your draft and
   * let the conflict stand. `"saved"`: the host saved the draft (the close
   * prompt's Save). `"discarded"`: the host dropped the draft — re-read.
   */
  readonly reason: "disk" | "saved" | "discarded";
  /**
   * The revision now on disk; null when the file is gone, grew past the
   * editor's `maxBytes`, or no longer reads as UTF-8 text.
   */
  readonly revision: string | null;
}

/**
 * The host-owned document a `location: "fileEditor"` view edits (#13809),
 * handed to it as {@link PanelViewProps.fileDocument}.
 *
 * The host reads and writes the file; the view never touches the filesystem
 * for it. A save names the revision it was based on and is refused, not
 * merged, when the file moved underneath — the same compare-and-replace the
 * built-in Markdown editor relies on, checked in the main process at write
 * time. A `mode: "view"` editor gets a read-only document.
 */
export interface PluginFileDocument {
  /** Absolute path of the file. */
  readonly filePath: string;
  /** Path relative to the project or worktree root, with forward slashes. */
  readonly relativePath: string;
  readonly fileName: string;
  /** The mode this editor was opened in. */
  readonly mode: FileEditorMode;
  /** True for a `mode: "view"` editor: `save` and `setDraft` are refused. */
  readonly readOnly: boolean;
  /** Read the file as it is on disk now. */
  read(): Promise<PluginFileDocumentReadResult>;
  /** Write `text` if the file is still at `expectedRevision`. Clears the draft on success. */
  save(text: string, options: { expectedRevision: string }): Promise<PluginFileDocumentSaveResult>;
  /**
   * The unsaved text the host holds for this panel, or null when clean — read
   * it on mount to restore a draft from before the user switched modes.
   */
  getDraft(): string | null;
  /** Report the unsaved text (null when clean). The host derives "dirty" from it. */
  setDraft(text: string | null): void;
  /**
   * Report a conflict your editor detected itself. It can raise the host's
   * conflict flag but never clear one the host observed on disk.
   */
  setConflict(conflict: boolean): void;
  /** Subscribe to changes made outside the view. Returns the unsubscribe. */
  onDidChange(listener: (change: PluginFileDocumentChange) => void): () => void;
}

/**
 * A view-backed file editor as main serves it with its hosted view (#13809):
 * the manifest entry with its defaults resolved.
 */
export interface HostedFileEditorDescriptor {
  /** The entry's bare id. */
  id: string;
  mode: FileEditorMode;
  extensions: readonly string[];
  /** Project-relative globs; always empty for an installed plugin. */
  paths: readonly string[];
  maxBytes: number;
}

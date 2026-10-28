// Editors: the host's code editor, its diff surface, and a Markdown field with
// Write and Preview.

import type { ReactNode, Ref } from "react";
import type { PluginIconSource, PluginRootAttributes } from "./common.js";

/** What a `CodeEditor`'s `ref` holds. */
export interface PluginCodeEditorHandle {
  /** Moves the keyboard into the editor, keeping its selection. */
  focus(): void;
  /** Opens the editor's find bar, as Cmd+F inside it does. */
  openSearch(): void;
}

/**
 * Props of `CodeEditor`: Daintree's own CodeMirror editor, with the file
 * viewer's theme, gutters, selection colours and find bar, and the languages
 * it highlights. Loads on first use: a skeleton holds its place until then.
 */
export interface PluginCodeEditorProps extends PluginRootAttributes {
  /** The text, controlled. Pair with `onChange`. */
  value?: string;
  /** The starting text when `value` is not given. */
  defaultValue?: string;
  /** Every edit, with the whole text. Never mid-way through an IME composition. */
  onChange?: (value: string) => void;
  /**
   * A language name, alias or file extension (`json`, `yaml`, `ts`, `tsx`,
   * `python`, `markdown`, `sql`, `rust`, `go`, `css`, `html`, …). Unknown or
   * omitted, the text is plain.
   */
  language?: string;
  /** Selectable and searchable, not editable. */
  readOnly?: boolean;
  /** Draws line numbers and fold markers. Defaults to true. */
  lineNumbers?: boolean;
  /** Wraps long lines instead of scrolling sideways. */
  wrap?: boolean;
  /** Shown while the text is empty. */
  placeholder?: string;
  /** The editor's smallest height, in px. */
  minHeight?: number;
  /** A height in px past which the editor scrolls. Without it, it grows with its text or fills the box you give it. */
  maxHeight?: number;
  /** Cmd+S (Ctrl+S) inside the editor, with the whole text. The key stops at the editor rather than bubbling on through the view. */
  onSave?: (value: string) => void;
  /** Takes focus once it has loaded. */
  autoFocus?: boolean;
  /** Draws the rounded field border. Pass `false` for an editor that fills a pane edge to edge. Defaults to true. */
  bordered?: boolean;
  /** Names the editor for assistive tech ("config.yaml"). */
  "aria-label"?: string;
  /** Classes for the outer box (size it here). */
  className?: string;
  ref?: Ref<PluginCodeEditorHandle>;
}

/**
 * One hunk of a `DiffView`, as its hunk actions receive it. Line numbers are
 * 1-based and counts are line counts, as the `@@` header prints them.
 */
export interface PluginDiffHunk {
  /** Its position among the file's hunks, from 0. */
  index: number;
  /** The file it belongs to, as the patch names it (empty for two texts without a `path`). */
  filePath: string;
  /** The `@@ -1,4 +1,5 @@` line, with any section heading after it. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The hunk's lines as they read before: its context and removed lines. */
  oldText: string;
  /** The hunk's lines as they read after: its context and added lines. */
  newText: string;
  /**
   * The hunk alone as a unified patch, file headers included, for `git apply`.
   * It carries no `\ No newline at end of file` marker, so a hunk that only
   * changes the final newline does not reproduce it.
   */
  patch: string;
}

/** A button in each hunk header of a `DiffView`. */
export interface PluginDiffHunkAction {
  /** Non-empty and unique; `onHunkAction` receives it. */
  id: string;
  /** The button's text ("Revert", "Stage"). */
  label: string;
  icon?: PluginIconSource;
  /** A tooltip when it says more than the label. */
  tooltip?: string;
  disabled?: boolean;
}

/**
 * Props of `DiffView`: Daintree's diff surface for two texts or a unified
 * patch, highlighted, unified or split, with the diff panel's gutters, hunk
 * headers and colours. Give `oldText` and `newText`, or `patch`.
 */
export interface PluginDiffViewProps extends PluginRootAttributes {
  /** The text before. With `newText`, the view diffs the two itself. */
  oldText?: string;
  /** The text after. */
  newText?: string;
  /** A unified patch (`git diff` output), one file or several. Used when the texts are not given. */
  patch?: string;
  /** The file path shown over a two-text diff, which also picks its highlighting. */
  path?: string;
  /** A grammar name or alias (`ts`, `json`, `yaml`, …) in place of the one the path implies. */
  language?: string;
  /** Defaults to `unified`. `split` puts the two sides next to each other. */
  view?: "unified" | "split";
  /** Wraps long lines instead of scrolling sideways. */
  wrap?: boolean;
  /**
   * Unchanged lines kept around each change of a two-text diff. The rest fold
   * behind "Expand" buttons in the hunk headers. Defaults to 3.
   */
  context?: number;
  /** Buttons in every hunk header: the same list for each hunk, or a list per hunk. */
  hunkActions?:
    readonly PluginDiffHunkAction[] | ((hunk: PluginDiffHunk) => readonly PluginDiffHunkAction[]);
  /** A hunk action was pressed. */
  onHunkAction?: (actionId: string, hunk: PluginDiffHunk) => void;
  /** Your own controls at the end of each hunk header, drawn after `hunkActions`. */
  renderHunkActions?: (hunk: PluginDiffHunk) => ReactNode;
  /** A height in px past which the view scrolls, keeping its file header pinned. */
  maxHeight?: number;
  /** Names the diff for assistive tech. Defaults to the file path. */
  "aria-label"?: string;
  className?: string;
}

export type PluginMarkdownEditorMode = "write" | "preview";

/**
 * Props of `MarkdownEditor`: a Markdown field for comments, descriptions and
 * notes. A text area that grows with its text, a toolbar for bold, italic,
 * code, links and lists, and a Write and Preview toggle (or both side by side
 * when there is room) rendered through the kit's `Markdown`.
 */
export interface PluginMarkdownEditorProps extends PluginRootAttributes {
  /** The source, controlled. Pair with `onChange`. */
  value?: string;
  /** The starting source when `value` is not given. */
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** The side shown, controlled. */
  mode?: PluginMarkdownEditorMode;
  /** The side shown first when `mode` is not given. Defaults to `write`. */
  defaultMode?: PluginMarkdownEditorMode;
  onModeChange?: (mode: PluginMarkdownEditorMode) => void;
  /**
   * `tabs` (the default) switches between Write and Preview. `split` shows the
   * source and its preview side by side. `auto` goes side by side once the
   * editor is at least 720px wide.
   */
  layout?: "tabs" | "split" | "auto";
  /**
   * Fills the height its parent gives it instead of growing with its text, for
   * an editor that is a whole pane's document. The source and the preview each
   * scroll inside the editor, `minRows` and `maxRows` no longer apply, and
   * with a side-by-side `layout` the two scroll in step. The parent needs a
   * definite height: a `PaneLayout` with `scroll="none"`, or a flex column with a bounded height.
   */
  fill?: boolean;
  /**
   * A slot above the field, for what describes the document rather than being
   * its text: front matter edited as a `SchemaForm`, say. It keeps its own
   * height, scrolls once it passes 40% of a `fill` editor, and is yours to
   * disable, like the rest of what you put in it.
   */
  header?: ReactNode;
  /** Cmd+Enter (Ctrl+Enter), with the source: post the comment, save the note. */
  onSubmit?: (value: string) => void;
  /** Escape in the text area: close the composer. */
  onCancel?: () => void;
  /** Rows the text area starts at. Defaults to 3. */
  minRows?: number;
  /** Rows it grows to before it scrolls. Defaults to 16. */
  maxRows?: number;
  /** Draws the formatting toolbar. Defaults to true. */
  toolbar?: boolean;
  /** A row under the field, for its buttons ("Cancel", "Comment") and a hint. */
  footer?: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** Draws the field with the error border. */
  invalid?: boolean;
  /** What the preview's relative links and images resolve against, as on `Markdown`. */
  basePath?: string;
  /** The directory the preview's local links and images must stay inside, as on `Markdown`. */
  rootPath?: string;
  /** Names the text area for assistive tech ("Release notes"). */
  "aria-label"?: string;
  className?: string;
}

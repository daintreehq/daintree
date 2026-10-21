import { Save } from "lucide-react";
import { Button } from "@daintreehq/plugin-ui";
import { FILE_METADATA_STRIP_CLASS } from "@/components/FileViewer/fileMetadataStrip";
import { FileMetadataFacts, type FileLineEnding } from "@/components/FileViewer/FileMetadataFacts";
import { matchCodeMirrorLanguage } from "@/components/FileViewer/codeMirrorLanguages";

export interface MarkdownEditorStatusBarProps {
  /** Names the language fact, matched the way Source mode's viewer matches it. */
  filePath: string;
  lineCount: number;
  /** The bytes a save would write: BOM and line endings included. */
  byteLength: number;
  hasBom: boolean;
  /** "LF" or "CRLF" — what an edited save normalises every line to. */
  eolLabel: string;
  /** The endings the file has now, which a save may not keep; null for a single line. */
  lineEnding: FileLineEnding | null;
  dirty: boolean;
  saving: boolean;
  /** Saving is held while a disk conflict is unresolved. */
  saveBlocked: boolean;
  onSave: () => void;
}

/**
 * The metadata strip above the editor buffer: what the bytes on disk are, what
 * state the draft is in, and the one action that resolves it.
 *
 * Split out of `MarkdownEditorView` because it is the surface Source mode and
 * Edit mode share — the reader's own strip in `FilePane` renders the same facts
 * from `FILE_METADATA_STRIP_CLASS`, and the two have to line up to the pixel
 * when the mode toggles under the cursor. That is why the button is `h-6`
 * inside a `h-7` row rather than sizing the row: an `xs` button is exactly
 * short enough to leave the row the height the reader's strip already is.
 *
 * Three tiers, deliberately: the file's bytes are reference the user consults
 * rarely (secondary), the draft's state is the question the strip exists to
 * answer (primary while it is anything other than saved), and mixed line
 * endings are a T1 ambient warning — a property of the file that a save will
 * silently change, which is not a banner (see `.claude/rules/user-signals.md`:
 * lowest tier that stays actionable).
 */
export function MarkdownEditorStatusBar({
  filePath,
  lineCount,
  byteLength,
  hasBom,
  eolLabel,
  lineEnding,
  dirty,
  saving,
  saveBlocked,
  onSave,
}: MarkdownEditorStatusBarProps) {
  const state = saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";

  return (
    <div data-testid="markdown-editor-status" className={FILE_METADATA_STRIP_CLASS}>
      {/* The metadata run yields its width to the state and the action: under
          pressure a dropped byte count is worth less than a legible answer to
          "are my edits safe?". Mixed endings stay a T1 warning inside the run,
          worded as Source mode words it so the facts don't move on a toggle;
          only its tooltip differs, because here a save changes the file. */}
      <FileMetadataFacts
        facts={{
          language: matchCodeMirrorLanguage(filePath)?.name ?? "Plain text",
          lineCount,
          byteLength,
          encoding: hasBom ? "utf-8-bom" : "utf-8",
          lineEnding,
        }}
        mixedEndingsTooltip={`This file has more than one kind of line ending. Saving normalises every line to ${eolLabel}.`}
      />

      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        {/* No `aria-live` here: `DocumentController` already announces every
            terminal result through the app-global announcer, and a second live
            region would both double those announcements and fire on the first
            keystroke of every edit. This is the visible reading of the same
            state, reachable by ordinary screen-reader navigation. */}
        <span
          className={dirty || saving ? "text-text-primary" : undefined}
          data-testid="markdown-editor-dirty-state"
        >
          {state}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={onSave}
          // `saving` is deliberately absent from `disabled` and carried by
          // `loading` instead: the primitive blocks activation through ARIA
          // precisely so the button keeps focus across the write, and a native
          // `disabled` here would drop a keyboard user out of the strip the
          // moment they pressed it.
          disabled={!dirty || saveBlocked}
          loading={saving}
          aria-label="Save file"
          data-testid="markdown-editor-save"
          icon={<Save />}
        >
          Save
        </Button>
      </span>
    </div>
  );
}

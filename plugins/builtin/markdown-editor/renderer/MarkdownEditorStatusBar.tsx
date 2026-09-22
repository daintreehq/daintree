import { AlertTriangle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/formatBytes";
import {
  FILE_METADATA_RUN_CLASS,
  FILE_METADATA_STRIP_CLASS,
} from "@/components/FileViewer/fileMetadataStrip";

export interface MarkdownEditorStatusBarProps {
  lineCount: number;
  byteLength: number;
  hasBom: boolean;
  /** "LF" or "CRLF" — what the file has, and what a save normalises to. */
  eolLabel: string;
  mixedEol: boolean;
  dirty: boolean;
  saving: boolean;
  /** Saving is held while a disk conflict is unresolved. */
  saveBlocked: boolean;
  onSave: () => void;
}

/** A dimmed dot between two metadata facts. Hidden from AT, which reads the items. */
function Dot() {
  return (
    <span aria-hidden="true" className="text-text-muted">
      ·
    </span>
  );
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
  lineCount,
  byteLength,
  hasBom,
  eolLabel,
  mixedEol,
  dirty,
  saving,
  saveBlocked,
  onSave,
}: MarkdownEditorStatusBarProps) {
  const state = saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";

  return (
    <div data-testid="markdown-editor-status" className={FILE_METADATA_STRIP_CLASS}>
      {/* The metadata run yields its width to the state and the action: under
          pressure a truncated byte count is worth less than a legible answer to
          "are my edits safe?". */}
      <span className={FILE_METADATA_RUN_CLASS}>
        <span className="tabular-nums">{lineCount} lines</span>
        <Dot />
        <span className="tabular-nums">{formatBytes(byteLength)}</span>
        <Dot />
        <span>UTF-8{hasBom ? " with BOM" : ""}</span>
        <Dot />
        <span>{eolLabel}</span>
      </span>

      {mixedEol && (
        <span
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-status-warning"
          title={`This file mixes LF and CRLF line endings. Saving normalises every line to ${eolLabel}.`}
          data-testid="markdown-editor-mixed-eol"
        >
          <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          Mixed endings → {eolLabel}
        </span>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
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
          className="text-xs"
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
        >
          <Save />
          Save
        </Button>
      </span>
    </div>
  );
}

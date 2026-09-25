import { memo, useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { formatDiffNoteLines, type DiffNote, type DiffNoteAnchor } from "./diffNotes";

interface DiffNoteEditorProps {
  initialBody: string;
  label: string;
  saveLabel: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}

/**
 * Typed text lives here, not in the store: the store is persisted and shared
 * across project views, and every keystroke there would reserialize it — and
 * would rebuild the diff's widget map under the caret.
 */
function DiffNoteEditor({ initialBody, label, saveLabel, onSave, onCancel }: DiffNoteEditorProps) {
  const [body, setBody] = useState(initialBody);
  const canSave = body.trim().length > 0;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) onSave(body);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={label}
        autoFocus
        density="compact"
        rows={3}
        value={body}
        placeholder="Leave a note for the agent"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="contrast"
          size="xs"
          disabled={!canSave}
          onClick={() => onSave(body)}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

function describeAnchor(anchor: DiffNoteAnchor): string {
  if (anchor.kind === "file") return "File note";
  const lines = formatDiffNoteLines(anchor);
  return anchor.startLine === anchor.endLine ? `Line ${lines}` : `Lines ${lines}`;
}

/** "file note" or "note on line 12", for accessible names built around it. */
function nameAnchor(anchor: DiffNoteAnchor): string {
  const described = describeAnchor(anchor);
  return anchor.kind === "file" ? "file note" : `note on ${described.toLowerCase()}`;
}

interface DiffNoteComposerProps {
  worktreePath: string;
  filePath: string;
  anchor: DiffNoteAnchor;
  onDone: () => void;
}

export const DiffNoteComposer = memo(function DiffNoteComposer({
  worktreePath,
  filePath,
  anchor,
  onDone,
}: DiffNoteComposerProps) {
  const addNote = useDiffNotesStore((s) => s.addNote);
  return (
    <div className="diff-note" data-testid="diff-note-composer">
      <div className="mb-1.5 text-xs text-text-secondary">{describeAnchor(anchor)}</div>
      <DiffNoteEditor
        initialBody=""
        label={`New ${nameAnchor(anchor)}`}
        saveLabel="Add note"
        onSave={(body) => {
          addNote({ worktreePath, filePath, anchor, body });
          onDone();
        }}
        onCancel={onDone}
      />
    </div>
  );
});

/**
 * Why a line note sits above the table instead of under its lines: `stale`
 * means those rows now read differently; `unplaced` means they aren't rendered,
 * so nothing says either way.
 */
export type DiffNoteCardPlacement = "stale" | "unplaced" | undefined;

interface DiffNoteCardProps {
  note: DiffNote;
  placement?: DiffNoteCardPlacement;
}

export const DiffNoteCard = memo(function DiffNoteCard({ note, placement }: DiffNoteCardProps) {
  const stale = placement === "stale";
  const saveNote = useDiffNotesStore((s) => s.saveNote);
  const deleteNote = useDiffNotesStore((s) => s.deleteNote);
  const markEditing = useDiffNotesStore((s) => s.setEditing);
  const [editing, setEditing] = useState(false);
  const noteId = note.id;

  useEffect(() => {
    if (!editing) return;
    markEditing(noteId, true);
    return () => markEditing(noteId, false);
  }, [editing, noteId, markEditing]);
  const anchorLabel = describeAnchor(note.anchor);

  return (
    <div
      className="diff-note"
      data-testid="diff-note"
      data-stale={stale || undefined}
      aria-label={nameAnchor(note.anchor)}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary">
        <span>{anchorLabel}</span>
        {stale && (
          <span
            className="inline-flex items-center gap-1 text-status-warning"
            title="The diff changed under this note, so it's shown here instead of at its lines"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            Stale
          </span>
        )}
        {placement === "unplaced" && (
          <span title="These lines aren't shown in this diff right now">Not in view</span>
        )}
        {!editing && (
          <span className="ml-auto flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Edit note"
              title="Edit note"
              onClick={() => setEditing(true)}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Delete note"
              title="Delete note"
              onClick={() => deleteNote(note.id)}
            >
              <Trash2 />
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <DiffNoteEditor
          initialBody={note.body}
          label={`Edit ${nameAnchor(note.anchor)}`}
          saveLabel="Save"
          onSave={(body) => {
            saveNote(note, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{note.body}</p>
      )}
    </div>
  );
});

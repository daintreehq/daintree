import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Literal text, edited as plain text and written verbatim — main's decoded
 * value includes its whitespace, so nothing is trimmed on the way back. Enter
 * saves (Cmd or Ctrl+Enter for multi-line text), Escape puts the original back;
 * nothing is written until one of those, so a stray click away never becomes a
 * source change.
 *
 * At rest it is a property value: the text itself is the click target, sitting
 * in the control column of its row with a persistent pencil beside it. It used
 * to be a paragraph and a separate "Edit text" button — a value that looked
 * like a sentence and a control that looked like a link, in a row of their own.
 */
export function TextEditor({
  text,
  editable,
  saving,
  pending = false,
  onSave,
}: {
  text: string;
  editable: boolean;
  saving: boolean;
  /** A re-proof is out after a write: no commit, but the field keeps focus. */
  pending?: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const errorId = useId();

  const cancel = () => {
    setEditing(false);
    setDraft(text);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const save = () => {
    if (draft.trim().length === 0) return;
    if (draft === text) {
      cancel();
      return;
    }
    onSave(draft);
  };

  const begin = () => {
    if (!editable) return;
    setDraft(text);
    setEditing(true);
  };

  const multiline = text.includes("\n");
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Keys typed into the field belong to the field, not to panel shortcuts.
    event.stopPropagation();
    // A composing IME sends Enter to accept its own candidate; treating that as
    // "save" writes the user's source file mid-word.
    if (event.key === "Enter" && event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (editable && !saving) save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <div className="flex min-h-7 items-center gap-1">
        {/* The value is the target. One button, named for what it does, whose
            label IS the current text — so a screen reader hears the value and
            the action together. */}
        <button
          ref={triggerRef}
          type="button"
          disabled={!editable}
          aria-label={`Edit text: ${text}`}
          onClick={begin}
          className={cn(
            "-mx-1.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-sm text-text-primary transition-colors duration-150 ease-out",
            editable ? "hover:bg-overlay-subtle" : "cursor-default opacity-60"
          )}
        >
          <span className={cn("min-w-0 flex-1", multiline ? "line-clamp-2" : "truncate")}>
            {text}
          </span>
          <Pencil className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const empty = draft.trim().length === 0;
  return (
    <div className="flex flex-col gap-1.5">
      {multiline ? (
        <Textarea
          density="compact"
          aria-label="Text"
          value={draft}
          disabled={!editable && !saving && !pending}
          readOnly={saving || pending}
          invalid={empty}
          aria-describedby={empty ? errorId : undefined}
          autoFocus
          rows={Math.min(8, text.split("\n").length)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <Input
          density="compact"
          aria-label="Text"
          value={draft}
          disabled={!editable && !saving && !pending}
          readOnly={saving || pending}
          invalid={empty}
          aria-describedby={empty ? errorId : undefined}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      {empty ? (
        <p id={errorId} className="text-xs text-status-error">
          Text can't be empty
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          variant="subtle"
          size="xs"
          loading={saving}
          disabled={!editable || empty}
          onClick={save}
        >
          Save
        </Button>
        <Button variant="ghost" size="xs" onClick={cancel}>
          Cancel
        </Button>
        <span className="text-3xs text-text-secondary">
          {multiline ? "⌘⏎ save · Esc cancel" : "⏎ save · Esc cancel"}
        </span>
      </div>
    </div>
  );
}

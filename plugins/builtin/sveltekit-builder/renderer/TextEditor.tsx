import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Literal text, edited as plain text. Enter saves, Escape puts the original
 * back; nothing is written until one of those, so a stray click away never
 * becomes a source change.
 */
export function TextEditor({
  text,
  editable,
  saving,
  onSave,
}: {
  text: string;
  editable: boolean;
  saving: boolean;
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
    const next = draft.trim();
    if (next.length === 0) return;
    if (next === text) {
      cancel();
      return;
    }
    onSave(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys typed into the field belong to the field, not to panel shortcuts.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      if (editable && !saving) save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words text-sm text-text-primary">{text}</p>
        <Button
          ref={triggerRef}
          variant="subtle"
          size="xs"
          disabled={!editable}
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
        >
          Edit text
        </Button>
      </div>
    );
  }

  const empty = draft.trim().length === 0;
  return (
    <div className="flex flex-col gap-2">
      <Input
        density="compact"
        aria-label="Text"
        value={draft}
        disabled={!editable && !saving}
        readOnly={saving}
        invalid={empty}
        aria-describedby={empty ? errorId : undefined}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
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
        <span className="text-3xs text-text-secondary">Enter to save, Esc to cancel</span>
      </div>
    </div>
  );
}

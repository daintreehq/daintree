import { useState } from "react";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { actionService } from "@/services/ActionService";
import {
  WORKTREE_CUSTOM_TITLE_MAX_LENGTH,
  isWorktreeCustomTitleTooLong,
  normalizeWorktreeCustomTitle,
} from "@/lib/worktreeCustomTitle";

interface EditWorktreeTitleDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktreeId: string;
  currentTitle: string | undefined;
  restoreFocusTo?: RestoreFocusTarget;
}

export function EditWorktreeTitleDialog({
  isOpen,
  onClose,
  worktreeId,
  currentTitle,
  restoreFocusTo,
}: EditWorktreeTitleDialogProps) {
  // Each opening starts from the stored title, not whatever was typed and
  // cancelled last time. Remounting the form on open rather than unmounting it
  // on close keeps its content in place through the exit animation.
  const [openCount, setOpenCount] = useState(0);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setOpenCount((count) => count + 1);
  }

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      restoreFocusTo={restoreFocusTo}
      data-testid="edit-worktree-title-dialog"
    >
      <EditWorktreeTitleForm
        key={`${worktreeId}:${openCount}`}
        onClose={onClose}
        worktreeId={worktreeId}
        currentTitle={currentTitle}
      />
    </AppDialog>
  );
}

function EditWorktreeTitleForm({
  onClose,
  worktreeId,
  currentTitle,
}: Omit<EditWorktreeTitleDialogProps, "isOpen" | "restoreFocusTo">) {
  const [value, setValue] = useState(currentTitle ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = normalizeWorktreeCustomTitle(value);
  const tooLong = isWorktreeCustomTitleTooLong(normalized);

  const save = async () => {
    if (tooLong || saving) return;
    setSaving(true);
    setError(null);
    const result = await actionService.dispatch(
      "worktree.setCustomTitle",
      { worktreeId, title: normalized || null },
      { source: "user" }
    );
    setSaving(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.error.message || "Couldn't save the title");
    }
  };

  return (
    <>
      <AppDialog.Header>
        <AppDialog.Title>Edit worktree title</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <Field>
          <FieldLabel>Custom title</FieldLabel>
          <Input
            value={value}
            spellCheck={false}
            disabled={saving}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              e.preventDefault();
              void save();
            }}
          />
          <FieldDescription>Leave blank to use the automatic title</FieldDescription>
          {tooLong ? (
            <FieldError>{`Use ${WORKTREE_CUSTOM_TITLE_MAX_LENGTH} characters or fewer`}</FieldError>
          ) : error ? (
            // A save's outcome, so it announces itself; length is told on focus.
            <FieldError role="alert">{error}</FieldError>
          ) : null}
        </Field>
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={{
          label: "Save",
          onClick: () => void save(),
          disabled: tooLong || saving,
          loading: saving,
        }}
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: saving }}
      />
    </>
  );
}

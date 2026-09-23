import { useEffect, useId, useRef, useState } from "react";
import { Pencil, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PresetColorPicker } from "../PresetColorPicker";
import { SETTINGS_CONTROL_WIDTH, SettingsRow } from "../SettingsGroup";
import type { AgentPreset } from "@/config/agents";

interface CustomPresetChromeProps {
  selectedPreset: AgentPreset;
  agentColor: string;
  isEditing: boolean;
  editName: string;
  onEditNameChange: (value: string) => void;
  /** Returns false when the name was refused and editing continues. */
  onCommitEdit: () => boolean;
  onCancelEdit: () => void;
  renameError: string | null;
  onStartEdit: (preset: AgentPreset) => void;
  onColorChange: (color: string | undefined) => void;
  onDisplayTitleChange: (value: string) => void;
  onDuplicate: (preset: AgentPreset) => void;
}

/** Name, colour and display title of a custom preset — the rows that identify it. */
export function CustomPresetChrome({
  selectedPreset,
  agentColor,
  isEditing,
  editName,
  onEditNameChange,
  onCommitEdit,
  onCancelEdit,
  renameError,
  onStartEdit,
  onColorChange,
  onDisplayTitleChange,
  onDuplicate,
}: CustomPresetChromeProps) {
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape unmount the input that has focus. Hand focus back to the
  // rename button then — but not after an ordinary blur, where the user already
  // put focus somewhere else on purpose.
  const restoreFocusRef = useRef(false);
  const errorId = useId();
  useEffect(() => {
    if (!isEditing && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      renameButtonRef.current?.focus();
    }
  }, [isEditing]);

  return (
    <>
      <SettingsRow
        id="agents-preset-detail"
        label={
          <span className="inline-flex items-center gap-2">
            <PresetColorPicker
              color={selectedPreset.color}
              agentColor={agentColor}
              onChange={onColorChange}
              ariaLabel="Preset color"
            />
            {isEditing ? (
              <input
                className="flex-1 text-sm font-medium bg-surface-canvas border border-border-strong rounded-[var(--radius-sm)] px-2 py-0.5 focus:outline-hidden focus-visible:border-accent-primary"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onBlur={() => void onCommitEdit()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    restoreFocusRef.current = true;
                    if (!onCommitEdit()) restoreFocusRef.current = false;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    restoreFocusRef.current = true;
                    onCancelEdit();
                  }
                }}
                autoFocus
                aria-label="Preset name"
                aria-invalid={renameError ? true : undefined}
                aria-describedby={renameError ? errorId : undefined}
                data-testid="preset-edit-input"
                placeholder="Preset name"
              />
            ) : (
              <button
                ref={renameButtonRef}
                type="button"
                className="flex items-center gap-1.5 text-sm font-medium text-text-primary hover:underline underline-offset-2 text-left"
                onClick={() => onStartEdit(selectedPreset)}
                aria-label={`Edit ${selectedPreset.name}`}
                title="Rename"
              >
                <span>{selectedPreset.name}</span>
                <Pencil size={12} className="text-text-secondary" aria-hidden="true" />
              </button>
            )}
          </span>
        }
        labelText={selectedPreset.name}
        description="The colour marks this preset on its launch button and panel tab"
        error={
          isEditing && renameError ? (
            // Local neutral text with a glyph: the row's own error colour is
            // status-coloured body text, which fails contrast on most themes.
            <span
              id={errorId}
              role="alert"
              className="flex items-start gap-1.5 text-text-secondary"
            >
              <TriangleAlert
                className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
                aria-hidden="true"
              />
              <span>{renameError}</span>
            </span>
          ) : undefined
        }
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => onDuplicate(selectedPreset)}
            aria-label={`Duplicate ${selectedPreset.name}`}
          >
            Duplicate
          </Button>
        }
      />
      <SettingsRow
        label="Display title"
        description="Shown on the panel tab and launch button instead of the preset name"
        control={({ labelId, descriptionId }) => (
          <Input
            id="preset-display-title-input"
            className={SETTINGS_CONTROL_WIDTH.wide}
            value={selectedPreset.displayTitle ?? ""}
            onChange={(e) => onDisplayTitleChange(e.target.value)}
            maxLength={100}
            placeholder={selectedPreset.name}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            data-testid="preset-display-title-input"
          />
        )}
      />
    </>
  );
}

/**
 * Deleting a custom preset is local and irreversible, so it confirms (D1) and sits as
 * the last row of the preset's group, never beside its routine actions.
 */
export function PresetDeleteRow({
  preset,
  onDelete,
}: {
  preset: AgentPreset;
  onDelete: (presetId: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <SettingsRow
        label={`Delete ${preset.name}`}
        labelText={preset.name}
        description="Sessions that launch with it switch back to the agent's own settings"
        control={
          <Button
            size="sm"
            variant="ghost-danger"
            onClick={() => setConfirmOpen(true)}
            aria-label={`Delete ${preset.name}`}
          >
            Delete preset
          </Button>
        }
      />
      <ConfirmDialog
        isOpen={confirmOpen}
        variant="destructive"
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onDelete(preset.id);
        }}
        title={`Delete '${preset.name}'?`}
        description="Its environment variables, arguments and fallbacks are deleted, and new sessions launch with the agent's own settings instead."
        confirmLabel="Delete preset"
      />
    </>
  );
}

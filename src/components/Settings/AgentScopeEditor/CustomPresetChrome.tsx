import { Copy, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PresetColorPicker } from "../PresetColorPicker";
import { SettingsRow } from "../SettingsGroup";
import type { AgentPreset } from "@/config/agents";

interface CustomPresetChromeProps {
  selectedPreset: AgentPreset;
  agentColor: string;
  isEditing: boolean;
  editName: string;
  onEditNameChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onStartEdit: (preset: AgentPreset) => void;
  onColorChange: (color: string | undefined) => void;
  onDisplayTitleChange: (value: string) => void;
  onDuplicate: (preset: AgentPreset) => void;
  onDelete: (presetId: string) => void;
}

export function CustomPresetChrome({
  selectedPreset,
  agentColor,
  isEditing,
  editName,
  onEditNameChange,
  onCommitEdit,
  onCancelEdit,
  onStartEdit,
  onColorChange,
  onDisplayTitleChange,
  onDuplicate,
  onDelete,
}: CustomPresetChromeProps) {
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
                className="flex-1 text-sm font-medium bg-surface-canvas border border-border-strong rounded px-2 py-0.5 focus:outline-hidden"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onBlur={onCommitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCommitEdit();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancelEdit();
                  }
                }}
                autoFocus
                data-testid="preset-edit-input"
                placeholder="Preset name..."
              />
            ) : (
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm font-medium text-text-primary hover:underline underline-offset-2 text-left"
                onClick={() => onStartEdit(selectedPreset)}
                aria-label={`Edit ${selectedPreset.name}`}
                title="Click to rename"
              >
                <span>{selectedPreset.name}</span>
                <Pencil size={12} className="text-text-secondary" aria-hidden="true" />
              </button>
            )}
          </span>
        }
        labelText={selectedPreset.name}
        control={
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onDuplicate(selectedPreset)}
              aria-label={`Duplicate ${selectedPreset.name}`}
              title="Duplicate"
            >
              <Copy />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost-danger"
              onClick={() => onDelete(selectedPreset.id)}
              aria-label={`Delete ${selectedPreset.name}`}
              title="Delete"
            >
              <Trash2 />
            </Button>
          </div>
        }
      />
      <SettingsRow
        label="Display title"
        description="Shown on the panel tab and launch button. Leave empty to use the preset name"
        layout="stacked"
        control={({ labelId, descriptionId }) => (
          <Input
            id="preset-display-title-input"
            value={selectedPreset.displayTitle ?? ""}
            onChange={(e) => onDisplayTitleChange(e.target.value)}
            maxLength={100}
            placeholder={`Uses preset name (${selectedPreset.name})`}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            data-testid="preset-display-title-input"
          />
        )}
      />
    </>
  );
}

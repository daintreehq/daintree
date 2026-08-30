import { Copy, Trash2, Pencil } from "lucide-react";
import { PresetColorPicker } from "../PresetColorPicker";
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
    <div
      id="agents-preset-detail"
      className="rounded-[var(--radius-md)] border border-border-default bg-daintree-bg/30 px-3 py-2.5 space-y-2.5"
    >
      <div className="flex items-center gap-2">
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
            className="flex items-center gap-1.5 text-sm font-medium text-text-primary hover:text-daintree-text/80 hover:underline underline-offset-2 transition-colors text-left"
            onClick={() => onStartEdit(selectedPreset)}
            aria-label={`Edit ${selectedPreset.name}`}
            title="Click to rename"
          >
            <span>{selectedPreset.name}</span>
            <Pencil size={12} className="text-daintree-text/30" />
          </button>
        )}
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          <button
            className="text-daintree-text/30 hover:text-text-primary transition-colors"
            onClick={() => onDuplicate(selectedPreset)}
            aria-label={`Duplicate ${selectedPreset.name}`}
            title="Duplicate"
          >
            <Copy size={13} />
          </button>
          <button
            className="text-daintree-text/30 hover:text-status-error transition-colors"
            onClick={() => onDelete(selectedPreset.id)}
            aria-label={`Delete ${selectedPreset.name}`}
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <label
          htmlFor="preset-display-title-input"
          className="text-xs font-medium text-text-secondary"
        >
          Display title
        </label>
        <input
          id="preset-display-title-input"
          className="w-full rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas px-3 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-placeholder"
          value={selectedPreset.displayTitle ?? ""}
          onChange={(e) => onDisplayTitleChange(e.target.value)}
          maxLength={100}
          placeholder={`Uses preset name (${selectedPreset.name})`}
          data-testid="preset-display-title-input"
        />
        <p className="text-xs text-text-secondary select-text">
          Shown on the panel tab and launch button. Leave empty to use the preset name.
        </p>
      </div>
    </div>
  );
}

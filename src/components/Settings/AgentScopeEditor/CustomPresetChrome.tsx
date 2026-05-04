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
  onDuplicate,
  onDelete,
}: CustomPresetChromeProps) {
  return (
    <div
      id="agents-preset-detail"
      className="flex items-center gap-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 px-3 py-2.5"
    >
      <PresetColorPicker
        color={selectedPreset.color}
        agentColor={agentColor}
        onChange={onColorChange}
        ariaLabel="Preset color"
      />
      {isEditing ? (
        <input
          className="flex-1 text-sm font-medium bg-daintree-bg border border-daintree-accent rounded px-2 py-0.5 focus:outline-hidden"
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
          className="flex items-center gap-1.5 text-sm font-medium text-daintree-text hover:text-daintree-text/80 hover:underline underline-offset-2 transition-colors text-left"
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
          className="text-daintree-text/30 hover:text-daintree-text transition-colors"
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
  );
}

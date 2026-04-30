import { useMemo, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AgentPreset } from "@/config/agents";

/**
 * Preset selector — replaces the native `<select>` + `<optgroup>` that can't
 * render color swatches inline. Uses a Popover listbox following the
 * AgentSelectorDropdown pattern, so we get color dots per preset name and
 * grouped sections ("CCR Routes" / "Custom") with proper visual separation.
 *
 * No search input — preset lists are small (typically 2-6 items). If this
 * grows past ~15 the AgentSelectorDropdown filter pattern can be ported.
 */

export interface PresetSelectorProps {
  selectedPresetId: string | undefined;
  allPresets: AgentPreset[];
  ccrPresets: AgentPreset[];
  /** Per-team shared presets sourced from `.daintree/presets/`. Defaults to empty. */
  projectPresets?: AgentPreset[];
  customPresets: AgentPreset[];
  onChange: (presetId: string | undefined) => void;
  agentColor: string;
}

type Item = {
  id: string;
  label: string;
  color: string;
  source: "default" | "ccr" | "project" | "custom";
};

function stripCcrPrefix(name: string): string {
  return name.replace(/^CCR:\s*/, "");
}

export function PresetSelector({
  selectedPresetId,
  allPresets: _allPresets,
  ccrPresets,
  projectPresets = [],
  customPresets,
  onChange,
  agentColor,
}: PresetSelectorProps) {
  const [open, setOpen] = useState(false);

  const selectedItem = useMemo((): Item => {
    if (!selectedPresetId) {
      return { id: "", label: "Default (all worktrees)", color: agentColor, source: "default" };
    }
    // Match precedence order from getMergedPresets: custom wins over project
    // wins over CCR on ID collision. Resolve the badge/label against the
    // entry that actually wins so the trigger reflects the effective preset.
    const custom = customPresets.find((f) => f.id === selectedPresetId);
    if (custom) {
      return {
        id: custom.id,
        label: custom.name,
        color: custom.color ?? agentColor,
        source: "custom",
      };
    }
    const project = projectPresets.find((f) => f.id === selectedPresetId);
    if (project) {
      return {
        id: project.id,
        label: project.name,
        color: project.color ?? agentColor,
        source: "project",
      };
    }
    const ccr = ccrPresets.find((f) => f.id === selectedPresetId);
    if (ccr) {
      return {
        id: ccr.id,
        label: stripCcrPrefix(ccr.name),
        color: ccr.color ?? agentColor,
        source: "ccr",
      };
    }
    // Stale selection — fall back to default presentation but don't clear
    // state here (the parent clears stale IDs on launch).
    return { id: "", label: "Default (no overrides)", color: agentColor, source: "default" };
  }, [selectedPresetId, ccrPresets, projectPresets, customPresets, agentColor]);

  const handleSelect = (id: string) => {
    onChange(id || undefined);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)]",
            "border border-border-strong bg-daintree-bg text-daintree-text",
            "hover:border-daintree-accent/50 transition-colors",
            "focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50"
          )}
          data-testid="preset-selector-trigger"
        >
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 border border-daintree-border/60"
            style={{ backgroundColor: selectedItem.color }}
            aria-hidden="true"
          />
          <span className="flex-1 text-left truncate">{selectedItem.label}</span>
          {selectedItem.source === "ccr" && (
            <span
              className="text-[9px] uppercase tracking-wide text-daintree-text/40 bg-daintree-text/5 px-1 py-0.5 rounded shrink-0"
              aria-hidden="true"
            >
              CCR
            </span>
          )}
          {selectedItem.source === "project" && (
            <span
              className="text-[9px] uppercase tracking-wide text-daintree-text/40 bg-daintree-text/5 px-1 py-0.5 rounded shrink-0"
              aria-hidden="true"
            >
              Project
            </span>
          )}
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-daintree-text/40 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="p-1"
        style={{ width: "var(--radix-popover-trigger-width)" }}
        data-testid="preset-selector-listbox"
      >
        <div role="listbox" aria-label="Preset" className="overflow-y-auto max-h-80">
          <PresetOption
            id=""
            label="Default (all worktrees)"
            color={agentColor}
            isSelected={!selectedPresetId}
            onSelect={handleSelect}
            testid="preset-option-default"
          />
          {ccrPresets.length > 0 && (
            <>
              <Divider label="CCR Routes" />
              {ccrPresets.map((f) => (
                <PresetOption
                  key={f.id}
                  id={f.id}
                  label={stripCcrPrefix(f.name)}
                  color={f.color ?? agentColor}
                  badge="CCR"
                  isSelected={selectedPresetId === f.id}
                  onSelect={handleSelect}
                  testid={`preset-option-${f.id}`}
                />
              ))}
            </>
          )}
          {projectPresets.length > 0 && (
            <>
              <Divider label="Project Shared" />
              {projectPresets.map((f) => (
                <PresetOption
                  key={`project-${f.id}`}
                  id={f.id}
                  label={f.name}
                  color={f.color ?? agentColor}
                  badge="Project"
                  isSelected={selectedPresetId === f.id}
                  onSelect={handleSelect}
                  testid={`preset-option-project-${f.id}`}
                />
              ))}
            </>
          )}
          {customPresets.length > 0 && (
            <>
              <Divider label="Custom" />
              {customPresets.map((f) => (
                <PresetOption
                  key={f.id}
                  id={f.id}
                  label={f.name}
                  color={f.color ?? agentColor}
                  isSelected={selectedPresetId === f.id}
                  onSelect={handleSelect}
                  testid={`preset-option-${f.id}`}
                />
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div
      className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-daintree-text/40"
      data-testid={`preset-group-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {label}
    </div>
  );
}

function PresetOption({
  id,
  label,
  color,
  badge,
  isSelected,
  onSelect,
  testid,
}: {
  id: string;
  label: string;
  color: string;
  badge?: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  testid?: string;
}) {
  return (
    <div
      role="option"
      aria-selected={isSelected}
      data-testid={testid}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(id);
        }
      }}
      tabIndex={0}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm",
        "hover:bg-overlay-soft focus:bg-overlay-soft focus:outline-hidden",
        isSelected && "text-daintree-text font-medium bg-overlay-selected"
      )}
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0 border border-daintree-border/60"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span
          className="text-[9px] uppercase tracking-wide text-daintree-text/40 bg-daintree-text/5 px-1 py-0.5 rounded"
          aria-hidden="true"
        >
          {badge}
        </span>
      )}
      {isSelected && <Check size={12} className="shrink-0" aria-hidden="true" />}
    </div>
  );
}

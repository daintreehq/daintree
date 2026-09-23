import { useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AgentPreset } from "@/config/agents";

/**
 * Preset selector — replaces the native `<select>` + `<optgroup>` that can't
 * render color swatches inline. A Popover listbox with a colour dot per preset
 * and grouped sections ("CCR routes" / "Project shared" / "Custom").
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
  /** Wires the trigger to the row label that names it. */
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

type Item = {
  id: string;
  label: string;
  color: string;
  source: "default" | "ccr" | "project" | "custom";
};

const DEFAULT_LABEL = "Default settings";

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
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: PresetSelectorProps) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const valueId = useId();
  const listboxRef = useRef<HTMLDivElement>(null);

  const selectedItem = useMemo((): Item => {
    if (!selectedPresetId) {
      return { id: "", label: DEFAULT_LABEL, color: agentColor, source: "default" };
    }
    // Match precedence order from getMergedPresets: custom wins over project
    // wins over CCR on ID collision. Resolve the badge/label against the
    // entry that actually wins so the trigger reflects the effective preset.
    const custom = customPresets.find((f) => f.id === selectedPresetId);
    if (custom) {
      return {
        id: custom.id,
        label: custom.displayTitle ?? custom.name,
        color: custom.color ?? agentColor,
        source: "custom",
      };
    }
    const project = projectPresets.find((f) => f.id === selectedPresetId);
    if (project) {
      return {
        id: project.id,
        label: project.displayTitle ?? project.name,
        color: project.color ?? agentColor,
        source: "project",
      };
    }
    const ccr = ccrPresets.find((f) => f.id === selectedPresetId);
    if (ccr) {
      return {
        id: ccr.id,
        label: ccr.displayTitle ?? stripCcrPrefix(ccr.name),
        color: ccr.color ?? agentColor,
        source: "ccr",
      };
    }
    // Stale selection — fall back to default presentation but don't clear
    // state here (the parent clears stale IDs on launch).
    return { id: "", label: DEFAULT_LABEL, color: agentColor, source: "default" };
  }, [selectedPresetId, ccrPresets, projectPresets, customPresets, agentColor]);

  // Flat option order, in the order the groups render, for arrow-key movement.
  const options: Item[] = [
    { id: "", label: DEFAULT_LABEL, color: agentColor, source: "default" },
    ...ccrPresets.map((f): Item => ({
      id: f.id,
      label: f.displayTitle ?? stripCcrPrefix(f.name),
      color: f.color ?? agentColor,
      source: "ccr",
    })),
    ...projectPresets.map((f): Item => ({
      id: f.id,
      label: f.displayTitle ?? f.name,
      color: f.color ?? agentColor,
      source: "project",
    })),
    ...customPresets.map((f): Item => ({
      id: f.id,
      label: f.displayTitle ?? f.name,
      color: f.color ?? agentColor,
      source: "custom",
    })),
  ];
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.id === (selectedPresetId ?? "") && o.source === selectedItem.source)
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  // The highlight fill alone is too faint to find by keyboard, so arrow-key movement
  // also rings the active option. A pointer only fills it.
  const [keyboardNav, setKeyboardNav] = useState(false);
  // Opened with the keyboard, the ring shows from the first frame; opened with a
  // pointer, it waits for an arrow key.
  const openedByPointerRef = useRef(false);

  const optionDomId = (index: number) => `${listboxId}-option-${index}`;

  const handleSelect = (id: string) => {
    onChange(id || undefined);
    setOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setActiveIndex(selectedIndex);
      setKeyboardNav(!openedByPointerRef.current);
    }
    openedByPointerRef.current = false;
    setOpen(next);
  };

  // One tab stop: focus sits on the listbox and the arrows move the active option,
  // which `aria-activedescendant` announces. Enter or Space picks it.
  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    const move = (index: number) => {
      e.preventDefault();
      setActiveIndex(index);
      setKeyboardNav(true);
      document.getElementById(optionDomId(index))?.scrollIntoView?.({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        move(Math.min(activeIndex + 1, last));
        break;
      case "ArrowUp":
        move(Math.max(activeIndex - 1, 0));
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(last);
        break;
      case "Enter":
      case " ": {
        const option = options[activeIndex];
        if (option) {
          e.preventDefault();
          handleSelect(option.id);
        }
        break;
      }
    }
  };

  const renderOption = (item: Item, index: number, testid: string) => (
    <PresetOption
      key={`${item.source}-${item.id}`}
      domId={optionDomId(index)}
      item={item}
      isSelected={item.source === selectedItem.source && item.id === selectedItem.id}
      isActive={index === activeIndex}
      showRing={keyboardNav && index === activeIndex}
      onSelect={handleSelect}
      onHover={() => {
        setActiveIndex(index);
        setKeyboardNav(false);
      }}
      testid={testid}
    />
  );

  const ccrStart = 1;
  const projectStart = ccrStart + ccrPresets.length;
  const customStart = projectStart + projectPresets.length;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          // The row label names the control; the value span says what it is set to.
          aria-labelledby={ariaLabelledBy ? `${ariaLabelledBy} ${valueId}` : undefined}
          aria-describedby={ariaDescribedBy}
          className={cn(
            "flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)]",
            "border border-border-strong bg-surface-canvas text-text-primary transition-colors",
            // Radix hands focus back to the trigger when the list closes, so a `focus:`
            // indicator stayed lit after every pick — accent only for keyboard focus.
            "focus:outline-hidden focus-visible:border-accent-primary"
          )}
          data-testid="preset-selector-trigger"
          onPointerDown={() => {
            openedByPointerRef.current = true;
          }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 border border-border-default"
            style={{ backgroundColor: selectedItem.color }}
            aria-hidden="true"
          />
          <span id={valueId} className="flex-1 text-left truncate">
            {selectedItem.label}
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-text-secondary transition-transform",
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
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          listboxRef.current?.focus();
        }}
      >
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label="Preset"
          tabIndex={0}
          aria-activedescendant={optionDomId(activeIndex)}
          onKeyDown={handleListKeyDown}
          // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- focus is shown on the active option (aria-activedescendant), which is always highlighted
          className="overflow-y-auto max-h-80 focus:outline-hidden"
        >
          {renderOption(options[0]!, 0, "preset-option-default")}
          {ccrPresets.length > 0 && (
            <div role="group" aria-label="CCR routes">
              <Divider label="CCR routes" />
              {options
                .slice(ccrStart, projectStart)
                .map((item, i) => renderOption(item, ccrStart + i, `preset-option-${item.id}`))}
            </div>
          )}
          {projectPresets.length > 0 && (
            <div role="group" aria-label="Project shared">
              <Divider label="Project shared" />
              {options
                .slice(projectStart, customStart)
                .map((item, i) =>
                  renderOption(item, projectStart + i, `preset-option-project-${item.id}`)
                )}
            </div>
          )}
          {customPresets.length > 0 && (
            <div role="group" aria-label="Custom">
              <Divider label="Custom" />
              {options
                .slice(customStart)
                .map((item, i) => renderOption(item, customStart + i, `preset-option-${item.id}`))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div
      className="px-2 pt-2 pb-1 text-xs font-medium text-text-secondary"
      data-testid={`preset-group-${label.toLowerCase().replace(/\s+/g, "-")}`}
      aria-hidden="true"
    >
      {label}
    </div>
  );
}

function PresetOption({
  domId,
  item,
  isSelected,
  isActive,
  showRing,
  onSelect,
  onHover,
  testid,
}: {
  domId: string;
  item: Item;
  isSelected: boolean;
  isActive: boolean;
  showRing: boolean;
  onSelect: (id: string) => void;
  onHover: () => void;
  testid?: string;
}) {
  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      data-testid={testid}
      data-highlighted={isActive || undefined}
      onClick={() => onSelect(item.id)}
      onMouseMove={onHover}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onSelect(item.id);
        }
      }}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm text-text-primary",
        isActive && "bg-overlay-selected",
        showRing && "outline-solid outline-2 -outline-offset-2 outline-selection-outline",
        isSelected && "font-medium"
      )}
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0 border border-border-default"
        style={{ backgroundColor: item.color }}
        aria-hidden="true"
      />
      <span className="flex-1 truncate">{item.label}</span>
      {isSelected && <Check size={12} className="shrink-0" aria-hidden="true" />}
    </div>
  );
}

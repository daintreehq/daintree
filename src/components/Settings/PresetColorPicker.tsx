import { useState } from "react";
import { Check, X } from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Preset color picker — inline HSV picker with a curated palette.
 *
 * Earlier revisions opened macOS NSColorPanel via a hidden `<input type="color">`,
 * but Radix's DismissableLayer fires focus/pointer events when the OS-level panel
 * steals focus, dismissing the popover before the user could pick a color (#6118).
 * Keeping all interaction inside the renderer avoids that race entirely.
 *
 * Palette borrowed from popular dark-themed tools (Linear, Raycast, GitHub
 * labels) — tuned for sufficient contrast on the dark Daintree background.
 */

const PALETTE = [
  "#e06c75", // red
  "#e5c07b", // yellow
  "#98c379", // green
  "#56b6c2", // teal
  "#61afef", // blue
  "#c678dd", // violet
  "#be5046", // dark red
  "#d19a66", // orange
  "#7c8fa8", // blue-gray
  "#abb2bf", // light gray
] as const;

const FALLBACK_COLOR = "#e06c75";

// Accept 3- or 6-digit hex. The preset sanitizer in `src/config/agents.ts`
// stores 3-digit colors as-is, so a stored "#abc" must round-trip through the
// picker without being treated as invalid (which would silently overwrite the
// user's color on Done).
const isValidHex = (value: string): value is `#${string}` =>
  /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);

const normalizeHex = (value: string): string => {
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const r = value[1];
    const g = value[2];
    const b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return value.toLowerCase();
};

const resolveInitialDraft = (color: string | undefined, agentColor: string): string => {
  if (color && isValidHex(color)) return normalizeHex(color);
  if (isValidHex(agentColor)) return normalizeHex(agentColor);
  return FALLBACK_COLOR;
};

export interface PresetColorPickerProps {
  /** Current color (hex) or undefined to inherit from the agent's default. */
  color: string | undefined;
  /** Called with the new hex color, or undefined to clear/inherit. */
  onChange: (color: string | undefined) => void;
  /** Agent brand color (used as visual reference when "Clear" is active). */
  agentColor: string;
  /** Accessible label for the trigger swatch. */
  ariaLabel?: string;
}

export function PresetColorPicker({
  color,
  onChange,
  agentColor,
  ariaLabel = "Pick preset color",
}: PresetColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [draftColor, setDraftColor] = useState<string>(() =>
    resolveInitialDraft(color, agentColor)
  );

  const effectiveColor = color ?? agentColor;

  const handleOpenChange = (next: boolean) => {
    if (next) setDraftColor(resolveInitialDraft(color, agentColor));
    setOpen(next);
  };

  const handleDone = () => {
    if (!isValidHex(draftColor)) return;
    onChange(normalizeHex(draftColor));
    setOpen(false);
  };

  const handleClear = () => {
    onChange(undefined);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-full ring-1 ring-transparent hover:ring-daintree-accent/50 focus-visible:ring-daintree-accent focus-visible:outline-hidden transition-all"
          aria-label={ariaLabel}
          title={ariaLabel}
          data-testid="preset-color-picker-trigger"
        >
          <span
            className="block w-4 h-4 rounded-full border border-daintree-border/60"
            style={{ backgroundColor: effectiveColor }}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-56 p-3 space-y-3"
        data-testid="preset-color-picker-popover"
      >
        <HexColorPicker
          color={draftColor}
          onChange={setDraftColor}
          className="!w-full"
          data-testid="preset-color-hex-picker"
        />
        <div className="grid grid-cols-5 gap-1">
          {PALETTE.map((c) => {
            const isSelected = draftColor.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                className={cn(
                  "w-5 h-5 rounded-full border border-daintree-border/60 relative focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent",
                  "hover:scale-110 transition-transform"
                )}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
                aria-pressed={isSelected}
                onClick={() => setDraftColor(c)}
                data-testid={`preset-color-swatch-${c.replace("#", "")}`}
              >
                {isSelected && (
                  <Check
                    size={10}
                    className="absolute inset-0 m-auto text-white drop-shadow pointer-events-none"
                    strokeWidth={3}
                  />
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-1 border-t border-daintree-border/50">
          <HexColorInput
            color={draftColor}
            onChange={setDraftColor}
            prefixed
            className="w-20 rounded border border-daintree-border/60 bg-daintree-bg px-1.5 py-0.5 text-[11px] font-mono uppercase text-daintree-text focus:outline-hidden focus:border-daintree-accent"
            aria-label="Hex color"
            data-testid="preset-color-hex-input"
          />
          <div className="flex-1" />
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-daintree-text/60 hover:text-daintree-text transition-colors"
            onClick={handleClear}
            data-testid="preset-color-clear"
          >
            <X size={11} />
            Clear
          </button>
          <button
            type="button"
            className="text-[11px] font-medium text-text-secondary hover:text-daintree-text underline-offset-2 hover:underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleDone}
            disabled={!isValidHex(draftColor)}
            data-testid="preset-color-done"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

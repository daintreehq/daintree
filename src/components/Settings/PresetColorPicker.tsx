import { useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Preset color picker — replaces the hidden native `<input type="color">` that
 * opened macOS NSColorPanel (a heavyweight floating window that obscured the
 * settings panel and offered no "reset" affordance).
 *
 * Shows a 2×5 grid of curated dark-mode swatches, a "Clear" (inherit from
 * agent) option, and a "Custom…" escape hatch that invokes the native picker
 * only when the user explicitly wants a non-palette color.
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
  const nativeInputRef = useRef<HTMLInputElement>(null);

  const effectiveColor = color ?? agentColor;

  const isValidHex = (value: string): value is `#${string}` => /^#[0-9a-f]{6}$/i.test(value);

  const pickerValue = isValidHex(color) ? color : isValidHex(agentColor) ? agentColor : "#e06c75";

  const handleSelect = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };

  const handleCustomClick = () => {
    nativeInputRef.current?.click();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-full ring-1 ring-transparent hover:ring-daintree-accent/50 focus-visible:ring-daintree-accent focus-visible:outline-none transition-all"
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
        className="w-auto p-2 space-y-2"
        data-testid="preset-color-picker-popover"
      >
        <div className="grid grid-cols-5 gap-1">
          {PALETTE.map((c) => {
            const isSelected = color?.toLowerCase() === c.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                className={cn(
                  "w-5 h-5 rounded-full border border-daintree-border/60 relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daintree-accent",
                  "hover:scale-110 transition-transform"
                )}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
                aria-pressed={isSelected}
                onClick={() => handleSelect(c)}
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
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-daintree-border/50">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-daintree-text/60 hover:text-daintree-text transition-colors"
            onClick={() => handleSelect(undefined)}
            data-testid="preset-color-clear"
          >
            <X size={11} />
            Clear
          </button>
          <button
            type="button"
            className="text-[11px] text-daintree-accent hover:text-daintree-accent/80 transition-colors"
            onClick={handleCustomClick}
            data-testid="preset-color-custom"
          >
            Custom…
          </button>
          <input
            ref={nativeInputRef}
            type="color"
            className="sr-only"
            value={pickerValue}
            onChange={(e) => handleSelect(e.target.value)}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

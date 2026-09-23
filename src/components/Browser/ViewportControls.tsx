import { useEffect, useRef } from "react";
import { ChevronDown, RotateCwSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ViewportPresetId } from "@shared/types/panel";
import {
  VIEWPORT_PRESET_LIST,
  getEffectiveViewportSize,
  getViewportPreset,
} from "@/panels/dev-preview/viewportPresets";

interface ViewportControlsProps {
  preset: ViewportPresetId;
  rotated: boolean;
  dpr: 1 | 2 | 3;
  fit: boolean;
  onPresetChange: (preset: ViewportPresetId) => void;
  onRotateToggle?: () => void;
  onDprChange?: (dpr: 1 | 2 | 3) => void;
  onFitToggle?: () => void;
}

const DPR_VALUES = [1, 2, 3] as const;

/**
 * The device-emulation bar: its own row under the toolbar while a device preset
 * is on, the way browser device toolbars sit above the viewport. Kept out of the
 * main row so entering device mode never takes width from the address.
 */
export function ViewportControls({
  preset,
  rotated,
  dpr,
  fit,
  onPresetChange,
  onRotateToggle,
  onDprChange,
  onFitToggle,
}: ViewportControlsProps) {
  const dprRowRef = useRef<HTMLDivElement>(null);
  const active = getViewportPreset(preset);
  const size = getEffectiveViewportSize(preset, rotated);

  useEffect(() => {
    const container = dprRowRef.current;
    if (!container || !onDprChange) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[role='radio']:not(:disabled)")
      );
      if (buttons.length === 0) return;
      const currentIndex = buttons.findIndex((b) => b === document.activeElement);
      let nextIndex: number;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        nextIndex = currentIndex < buttons.length - 1 ? currentIndex + 1 : 0;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1;
      } else if (e.key === "Home") {
        nextIndex = 0;
      } else if (e.key === "End") {
        nextIndex = buttons.length - 1;
      } else {
        return;
      }
      e.preventDefault();
      if (nextIndex === currentIndex) return;
      const nextButton = buttons[nextIndex];
      nextButton?.focus();
      // APG radiogroup contract: selection follows focus.
      const value = Number(nextButton?.getAttribute("data-dpr"));
      if (value === 1 || value === 2 || value === 3) onDprChange(value);
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [onDprChange]);

  return (
    <div
      role="group"
      aria-label="Device emulation"
      data-testid="browser-viewport-controls"
      className="flex items-center gap-1 px-2 py-1 border-t border-overlay overflow-hidden"
    >
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Device: ${active.label}`}
                className="toolbar-icon-button flex h-6 min-w-0 items-center gap-1 px-1.5 rounded-[var(--radius-md)] text-xs font-medium text-text-primary"
              >
                <span className="truncate">{active.label}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Choose device</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          <DropdownMenuRadioGroup
            value={preset}
            onValueChange={(value) => {
              const next = VIEWPORT_PRESET_LIST.find((p) => p.id === value);
              if (next && next.id !== preset) onPresetChange(next.id);
            }}
          >
            {VIEWPORT_PRESET_LIST.map((option) => (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                data-viewport-preset-id={option.id}
              >
                <span className="text-xs">{option.label}</span>
                <span className="ml-auto pl-3 text-2xs tabular-nums text-text-secondary">
                  {option.width} × {option.height}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <span
        data-testid="browser-viewport-size"
        className="shrink-0 px-1 text-xs tabular-nums text-text-secondary"
      >
        {size.width} × {size.height}
      </span>

      {onRotateToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRotateToggle}
              className="toolbar-icon-button shrink-0 p-1 rounded-[var(--radius-md)] text-text-secondary"
              aria-label="Landscape"
              aria-pressed={rotated}
            >
              <RotateCwSquare className="w-4 h-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {rotated ? "Rotate to portrait" : "Rotate to landscape"}
          </TooltipContent>
        </Tooltip>
      )}

      <div className="flex-1" />

      {onDprChange && (
        <div className="flex shrink-0 items-center gap-1">
          <span aria-hidden="true" className="text-2xs font-medium text-text-secondary">
            DPR
          </span>
          <div
            ref={dprRowRef}
            role="radiogroup"
            aria-label="Device pixel ratio"
            className="flex items-center gap-0.5 rounded-[var(--radius-md)] bg-overlay-subtle p-0.5"
          >
            {DPR_VALUES.map((value) => {
              const isSelected = dpr === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={`Device pixel ratio ${value}x`}
                  data-dpr={value}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => {
                    if (!isSelected) onDprChange(value);
                  }}
                  className={cn(
                    "toolbar-icon-button min-w-6 px-1 py-0.5 rounded-[var(--radius-sm)] text-xs font-medium tabular-nums",
                    isSelected ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  {value}×
                </button>
              );
            })}
          </div>
        </div>
      )}

      {onFitToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onFitToggle}
              className="toolbar-icon-button flex h-6 shrink-0 items-center px-2 rounded-[var(--radius-md)] text-xs font-medium text-text-secondary aria-pressed:text-text-primary"
              aria-label="Fit to pane"
              aria-pressed={fit}
            >
              Fit
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Scale the device down to fit the pane</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

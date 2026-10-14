import { ChevronDown, RotateCwSquare } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import type { ViewportPresetId } from "@shared/types/panel";
import { cn } from "@/lib/utils";
import {
  VIEWPORT_PRESET_LIST,
  getEffectiveViewportSize,
  getViewportPreset,
} from "@/panels/dev-preview/viewportPresets";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";

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

type DprKey = "1" | "2" | "3";

const DPR_BY_KEY: Record<DprKey, 1 | 2 | 3> = { "1": 1, "2": 2, "3": 3 };

const DPR_KEYS: DprKey[] = ["1", "2", "3"];

/** No-break spaces, so a tooltip that wraps never splits a size across lines. */
function formatSize(width: number, height: number): string {
  return `${width}\u00a0×\u00a0${height}`;
}

/**
 * Pixel ratio changes what the page sees (`devicePixelRatio`, `srcset`,
 * resolution queries) but never its CSS size, which is the confusion with Fit
 * worth heading off: the tooltip says so with the size in hand.
 */
function dprOptions(width: number, height: number): SegmentedRadioOption<DprKey>[] {
  return DPR_KEYS.map((key) => ({
    value: key,
    label: `${key}×`,
    ariaLabel: `Device pixel ratio ${key}x`,
    tooltip: `${key} device ${key === "1" ? "pixel" : "pixels"} per CSS pixel; the page stays ${formatSize(width, height)}`,
  }));
}

/**
 * The device-emulation bar: its own row under the toolbar while a device preset
 * is on, the way browser device toolbars sit above the viewport. Kept out of the
 * main row so entering device mode never takes width from the address.
 *
 * Everything that changes what the page sees (device, size, orientation, pixel
 * ratio) sits together on the left; Fit, which only changes how Daintree draws
 * it, sits apart on the right. In a narrow split pane the row wraps rather than
 * clipping, so pixel ratio and Fit drop to a second line and the device name
 * keeps its width.
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
  const active = getViewportPreset(preset);
  const size = getEffectiveViewportSize(preset, rotated);

  return (
    <div
      role="group"
      aria-label="Device emulation"
      data-testid="browser-viewport-controls"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-t border-overlay"
    >
      <div className="flex min-w-0 items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Device: ${active.label}`}
                  className="toolbar-icon-button flex h-6.5 min-w-0 items-center gap-1 px-1.5 rounded-[var(--radius-md)] text-xs font-medium text-text-primary"
                >
                  <span className="truncate">{active.label}</span>
                  <ChevronDown
                    className="h-3 w-3 shrink-0 text-text-secondary"
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Choose device · {active.label}</TooltipContent>
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
                  aria-label={`${option.label}, ${option.width} by ${option.height}`}
                >
                  {option.label}
                  <DropdownMenuMeta>
                    {option.width} × {option.height}
                  </DropdownMenuMeta>
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
                className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                aria-label="Landscape"
                aria-pressed={rotated}
              >
                <RotateCwSquare className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {rotated ? "Rotate to portrait" : "Rotate to landscape"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* One wrapper so pixel ratio and Fit wrap together: Fit alone on a
          second line reads as an accident. */}
      <div className="flex min-w-max flex-1 items-center gap-x-3">
        {onDprChange && (
          <div className="flex shrink-0 items-center gap-1">
            <span aria-hidden="true" className="text-2xs font-medium text-text-secondary">
              DPR
            </span>
            <SegmentedRadioGroup<DprKey>
              aria-label="Device pixel ratio"
              density="compact"
              options={dprOptions(size.width, size.height)}
              value={`${dpr}`}
              onChange={(next) => onDprChange(DPR_BY_KEY[next])}
            />
          </div>
        )}

        {onFitToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onFitToggle}
                className={cn(PANE_TOOLBAR_TEXT_BUTTON_CLASS, "ml-auto")}
                aria-label="Fit to pane"
                aria-pressed={fit}
              >
                Fit
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Shrink the preview to fit the pane; the page still sees{" "}
              {formatSize(size.width, size.height)}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

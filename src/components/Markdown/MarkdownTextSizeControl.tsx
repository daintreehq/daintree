import { useCallback } from "react";
import { ALargeSmall, Minus, Plus } from "lucide-react";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEFAULT_MARKDOWN_FONT_SIZE,
  MARKDOWN_FONT_SIZE_STEPS,
  type MarkdownFontSize,
} from "@/store/preferencesStore";

/**
 * What each rung measures at the app's 16px root, for the readout. Labels only:
 * the value that reaches the document is the type-scale token, never this
 * number — see `MARKDOWN_FONT_SIZE_TOKEN` in `MarkdownDocument.tsx`.
 */
const STEP_LABEL: Record<MarkdownFontSize, string> = {
  "2xs": "11",
  xs: "12",
  sm: "14",
  base: "16",
  lg: "18",
  xl: "20",
  "2xl": "24",
  "3xl": "30",
};

const stepAt = (value: MarkdownFontSize, delta: number): MarkdownFontSize | undefined =>
  MARKDOWN_FONT_SIZE_STEPS[MARKDOWN_FONT_SIZE_STEPS.indexOf(value) + delta];

export interface MarkdownTextSizeControlProps {
  value: MarkdownFontSize;
  onValueChange: (value: MarkdownFontSize) => void;
  "data-testid"?: string;
}

/**
 * Reading scale for rendered markdown, in the shape reading surfaces have
 * settled on (Safari Reader, Apple Books, Kindle): an "Aa" trigger in the
 * toolbar opening a stepper, rather than a second toolbar row that would cost
 * vertical space in every layout to serve one occasional adjustment (#12134).
 *
 * A `Popover` rather than the `DropdownMenu` its neighbour `FileBrowserViewOptions`
 * uses, because a stepper is a widget and not a menu: `role="menuitem"` on a
 * minus button claims a semantic that isn't true, and Radix's menu roving focus
 * is vertical-only, so a horizontally laid-out pair would be walked with
 * Up/Down. Inside a popover the three buttons are plain tab stops and the
 * arrow/+/- keys are free to mean what they say. Close-time focus and tooltip
 * restoration are the primitive's job either way (`overlay-focus-restore.ts`).
 *
 * The size is one app-level preference, so the control is stateless — it steps
 * whatever the store holds and both hosts show the same number.
 */
export function MarkdownTextSizeControl({
  value,
  onValueChange,
  "data-testid": testId,
}: MarkdownTextSizeControlProps) {
  const smaller = stepAt(value, -1);
  const larger = stepAt(value, 1);
  const label = STEP_LABEL[value];

  // The stepper's own accelerators, live only while the popover is open. There
  // is no global combo to reach for: Cmd+= / Cmd+- / Cmd+0 are whole-window
  // zoom and Cmd+Alt+= cycles workspaces, so a document-scale binding would
  // either collide or land on a combo nobody would find.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const next =
        event.key === "ArrowUp" || event.key === "+" || event.key === "="
          ? stepAt(value, 1)
          : event.key === "ArrowDown" || event.key === "-"
            ? stepAt(value, -1)
            : undefined;
      if (next === undefined) return;
      event.preventDefault();
      onValueChange(next);
    },
    [value, onValueChange]
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              // Same footprint as its neighbours in the row; the armed chip
              // `toolbar-icon-button` paints on `data-state="open"` carries the
              // only state this trigger has.
              className="toolbar-icon-button shrink-0 rounded-lg p-1.5 text-text-secondary"
              // Carries the current size, so a screen reader hears where the
              // document already is before opening anything.
              aria-label={`Text size, ${label} pixels`}
              data-testid={testId}
            >
              <ALargeSmall className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Text size</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="w-auto p-2"
        aria-label="Text size"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Decrease text size"
            disabled={smaller === undefined}
            onClick={() => smaller && onValueChange(smaller)}
            data-testid="markdown-text-size-decrease"
          >
            <Minus aria-hidden="true" />
          </Button>
          {/* A live region rather than a static readout: the popover stays open
              across a run of adjustments, so the value has to announce itself
              each time or the stepping is silent. */}
          <output
            aria-live="polite"
            aria-atomic="true"
            className="w-14 text-center text-xs tabular-nums text-text-primary"
            data-testid="markdown-text-size-value"
          >
            {label} px
          </output>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Increase text size"
            disabled={larger === undefined}
            onClick={() => larger && onValueChange(larger)}
            data-testid="markdown-text-size-increase"
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 w-full justify-center"
          disabled={value === DEFAULT_MARKDOWN_FONT_SIZE}
          onClick={() => onValueChange(DEFAULT_MARKDOWN_FONT_SIZE)}
          data-testid="markdown-text-size-reset"
        >
          Reset
        </Button>
      </PopoverContent>
    </Popover>
  );
}

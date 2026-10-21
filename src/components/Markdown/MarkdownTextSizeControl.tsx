import { useCallback, useId } from "react";
import { ALargeSmall, Minus, Plus, RotateCcw } from "lucide-react";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ARIA_DISABLED_INERT_CLASSES } from "@/components/ui/ariaDisabled";
import {
  POPOVER_HEADER_CLASS,
  POPOVER_HEADER_META_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEFAULT_MARKDOWN_FONT_SIZE,
  MARKDOWN_FONT_SIZE_STEPS,
  type MarkdownFontSize,
} from "@/store/preferencesStore";
import { PANE_TOOLBAR_ICON_BUTTON_CLASS } from "@/components/ui/paneToolbarStyles";

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

const stepAt = (value: MarkdownFontSize, delta: number): MarkdownFontSize | undefined => {
  const index = MARKDOWN_FONT_SIZE_STEPS.indexOf(value);
  // A value off the ladder can only arrive from a corrupt store, but -1 + 1
  // would land on the smallest rung and read as a deliberate step.
  if (index < 0) return undefined;
  return MARKDOWN_FONT_SIZE_STEPS[index + delta];
};

const DEFAULT_LABEL = STEP_LABEL[DEFAULT_MARKDOWN_FONT_SIZE];

/**
 * Ends of the ladder are announced, not removed. The native `disabled`
 * attribute drops focus the moment the attribute lands, so stepping up to the
 * last rung would blur the very button that was just activated — and a focusout
 * inside a Radix popover is exactly what dismisses it. `aria-disabled` says the
 * same thing to a screen reader while the button stays where the user left it,
 * and the shared inert classes draw it the way a natively disabled button looks:
 * dimmed, with no hover fill inviting a click that does nothing.
 */
const inert = (isInert: boolean) => isInert || undefined;

/** Inside the stepper's frame the ring is inset, so it never crosses the frame's edge. */
const STEPPER_BUTTON_CLASS = cn(ARIA_DISABLED_INERT_CLASSES, "focus-visible:-outline-offset-2");

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
  const titleId = useId();
  const scopeId = useId();

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
              className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
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
        className="w-48 p-0"
        aria-labelledby={titleId}
        aria-describedby={scopeId}
        onKeyDown={handleKeyDown}
      >
        <div className={POPOVER_HEADER_CLASS}>
          <span id={titleId} className={POPOVER_TITLE_CLASS}>
            Text size
          </span>
          {/* The panel reflowing behind the popover shows the change is local
              to this document; it cannot show that every other one follows. */}
          <span id={scopeId} className={POPOVER_HEADER_META_CLASS}>
            All Markdown files
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-2">
          {/* One framed control, so the readout reads as the stepper's value
              rather than a label floating between two buttons. */}
          <div className="flex items-center rounded-[var(--radius-md)] border border-border-default p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Decrease text size"
              aria-disabled={inert(smaller === undefined)}
              className={STEPPER_BUTTON_CLASS}
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
              className="flex-1 text-center text-xs tabular-nums text-text-primary"
              data-testid="markdown-text-size-value"
            >
              {label} px
            </output>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Increase text size"
              aria-disabled={inert(larger === undefined)}
              className={STEPPER_BUTTON_CLASS}
              onClick={() => larger && onValueChange(larger)}
              data-testid="markdown-text-size-increase"
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="xs"
            className={cn("w-full justify-center", ARIA_DISABLED_INERT_CLASSES)}
            // Same reason as the steppers: Reset disables itself by succeeding,
            // so a native `disabled` would blur the button under the pointer.
            aria-disabled={inert(value === DEFAULT_MARKDOWN_FONT_SIZE)}
            onClick={() =>
              value !== DEFAULT_MARKDOWN_FONT_SIZE && onValueChange(DEFAULT_MARKDOWN_FONT_SIZE)
            }
            data-testid="markdown-text-size-reset"
          >
            <RotateCcw aria-hidden="true" />
            {/* The destination is the label, so nobody has to press it to find out. */}
            Reset to default · {DEFAULT_LABEL} px
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The same ladder as a submenu, for a toolbar that has folded its secondary
 * controls into an overflow menu. One radio per rung rather than a stepper:
 * inside a menu, rows are the widget, and a stepper's minus/plus buttons would
 * claim a menu semantic they don't have (see the note on the popover above).
 */
export function MarkdownTextSizeMenuItems({
  value,
  onValueChange,
}: Pick<MarkdownTextSizeControlProps, "value" | "onValueChange">) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger aria-label={`Text size, ${STEP_LABEL[value]} px`}>
        <ALargeSmall className="mr-2 h-3.5 w-3.5" aria-hidden="true" data-menu-icon />
        Text size
        <DropdownMenuMeta>{STEP_LABEL[value]} px</DropdownMenuMeta>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          aria-label="Text size"
          value={value}
          onValueChange={(next) => {
            const step = MARKDOWN_FONT_SIZE_STEPS.find((candidate) => candidate === next);
            if (step) onValueChange(step);
          }}
        >
          {MARKDOWN_FONT_SIZE_STEPS.map((step) => (
            <DropdownMenuRadioItem
              key={step}
              value={step}
              aria-label={
                step === DEFAULT_MARKDOWN_FONT_SIZE ? `${STEP_LABEL[step]} px, default` : undefined
              }
            >
              {STEP_LABEL[step]} px
              {step === DEFAULT_MARKDOWN_FONT_SIZE && <DropdownMenuMeta>Default</DropdownMenuMeta>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

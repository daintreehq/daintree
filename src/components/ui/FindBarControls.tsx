import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";

/**
 * The pieces both find bars are built from — the terminal's and the embedded
 * browser's. They are one control in two places, and spelling each bar by hand
 * is how they drifted apart (different paddings, counts, disabled dims, a focus
 * ring on one and not the other). Each bar keeps its own options and handlers;
 * the chrome lives here.
 *
 * Every control is a pane-toolbar button, so hover, keyboard focus, the armed
 * chip for a pressed option and the 50% disabled treatment are the same as the
 * toolbar the bar floats over. Deliberately no clear button: Escape closes,
 * and select-all + type replaces.
 */

/** The floating panel. Placement and stacking stay with each host. */
export const FIND_BAR_CLASS =
  "flex items-center gap-1 rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated px-2 py-1 shadow-[var(--theme-shadow-floating)]";

/** Glyph size for the bar's icon buttons. */
export const FIND_BAR_ICON_CLASS = PANE_TOOLBAR_ICON_CLASS;

/**
 * The match count. "No results" steps up in ink rather than into status red:
 * the words already say what happened, and severity-coloured prose is a
 * settled no here.
 */
export function findBarCountClass(hasMatches: boolean): string {
  return cn(
    // An empty count keeps its live region mounted but takes no room.
    "px-1 empty:px-0 text-xs tabular-nums whitespace-nowrap",
    hasMatches ? "text-text-secondary" : "text-text-primary"
  );
}

/**
 * A search option (match case, regex, whole word). Pressing one never takes
 * focus from the field, so typing carries on after a click.
 */
export function FindBarToggle({
  pressed,
  label,
  tooltip,
  onToggle,
  className,
  children,
}: {
  pressed: boolean;
  label: string;
  tooltip: string;
  onToggle: () => void;
  /** Glyph treatment only (the regex option is set in mono). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            PANE_TOOLBAR_ICON_BUTTON_CLASS,
            "h-6.5 min-w-6.5 px-1.5 py-0 text-xs font-medium",
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Previous, next and close. A disabled button gets no pointer events, so its
 * tooltip hangs off a wrapper to stay reachable by hover.
 */
export function FindBarButton({
  label,
  tooltip,
  onClick,
  disabled = false,
  keepFieldFocus = false,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  /** Stepping through matches leaves focus in the field, like Enter does. */
  keepFieldFocus?: boolean;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={keepFieldFocus ? (e) => e.preventDefault() : undefined}
      disabled={disabled}
      aria-label={label}
      className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
    >
      {children}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

import type * as React from "react";
import { cn } from "@/lib/utils";
import { splitterKeyShortcuts, type SplitterGrowKey } from "@/hooks/useSplitterKeys";

/**
 * Where the handle sits relative to the pane it sizes. `left`/`right` straddle a
 * vertical edge and `top` lines the inside of a top edge, all as a 12px absolute
 * target. `inline` is in flow: a 12px row for a horizontal splitter, and for a
 * vertical one a 6px track (the width layout math reserves between two panes)
 * whose hit area reaches 3px past each side, so the target is still 12px.
 */
export type ResizeHandleEdge = "left" | "right" | "top" | "inline";

const EDGE_CLASS: Record<Exclude<ResizeHandleEdge, "inline">, string> = {
  left: "absolute inset-y-0 -left-1.5 w-3",
  right: "absolute inset-y-0 -right-1.5 w-3",
  top: "absolute inset-x-0 top-0 h-3",
};

const INLINE_CLASS = {
  vertical:
    "relative w-1.5 shrink-0 self-stretch before:absolute before:inset-y-0 before:-inset-x-0.75",
  horizontal: "h-3 shrink-0",
} as const;

/** The DOM width an `inline` vertical track reserves; the hit area is wider than this. */
export const RESIZE_HANDLE_INLINE_TRACK_PX = 6;

export interface ResizeHandleProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "role" | "aria-orientation" | "aria-label" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
> {
  ref?: React.Ref<HTMLDivElement>;
  /** The arrow that grows the pane. Fixes the separator's axis and the shortcuts it announces. */
  growKey: SplitterGrowKey;
  edge: ResizeHandleEdge;
  /** "Resize sidebar". The reset hint is appended here so no handle can forget it. */
  label: string;
  value: number;
  min: number;
  max: number;
  isResizing: boolean;
  /** Double-click. The keyboard's Enter/Space reset comes from `useSplitterKeys`. */
  onReset: () => void;
}

/**
 * Every draggable edge in the app: the sidebar, the assistant panel, a two-pane split,
 * the diagnostics dock, the dev-preview tool drawer, the dock popovers, the portal, the
 * file tree and the scratchpad. One target size, one grip ink ladder, one focus outline
 * and one reset gesture, so an edge reads and behaves the same wherever it sits.
 *
 * The caller owns placement extras (z-index) and the drag itself; pair it with
 * `useSplitterKeys` for the keyboard.
 */
export function ResizeHandle({
  ref,
  growKey,
  edge,
  label,
  value,
  min,
  max,
  isResizing,
  onReset,
  className,
  tabIndex = 0,
  ...props
}: ResizeHandleProps) {
  const vertical = growKey === "ArrowLeft" || growKey === "ArrowRight";
  const axis = vertical ? "vertical" : "horizontal";
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={axis}
      aria-label={`${label} (double-click to reset)`}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-keyshortcuts={splitterKeyShortcuts(growKey)}
      tabIndex={tabIndex}
      data-resizing={isResizing ? "true" : undefined}
      onDoubleClick={onReset}
      {...props}
      className={cn(
        "group/resize flex items-center justify-center transition-colors",
        vertical ? "cursor-col-resize" : "cursor-row-resize",
        edge === "inline" ? INLINE_CLASS[axis] : EDGE_CLASS[edge],
        // Keyboard focus is one solid inset outline, the single accent mark for the
        // handle; outline rather than ring so forced-colors redraws the same mark.
        "outline-hidden focus-visible:bg-overlay-medium focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        // Hover styling is off while resizing, or it outranks the drag state. On light
        // themes overlay-soft composites under the JND, so the hover scrim steps up.
        isResizing
          ? "bg-overlay-medium"
          : "hover:bg-overlay-soft [.light_&]:hover:bg-overlay-medium",
        className
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "rounded-full duration-150 delay-100",
          vertical ? "h-8 transition-[width]" : "w-8 transition-[height]",
          // The ink ladder: /20 rest, /35 hover, /50 focus and drag, each a step up on
          // light themes where low-alpha ink fades into the near-white track. The grip
          // stays neutral on focus; the outline is the accent.
          isResizing
            ? cn(vertical ? "w-0.5" : "h-0.5", "bg-text-primary/50 [.light_&]:bg-text-primary/55")
            : cn(
                vertical
                  ? "w-px group-hover/resize:w-0.5 group-focus-visible/resize:w-0.5"
                  : "h-px group-hover/resize:h-0.5 group-focus-visible/resize:h-0.5",
                "bg-text-primary/20 group-hover/resize:bg-text-primary/35 group-focus-visible/resize:bg-text-primary/50",
                "[.light_&]:bg-text-primary/25 [.light_&]:group-hover/resize:bg-text-primary/45",
                "[.light_&]:group-focus-visible/resize:bg-text-primary/55"
              )
        )}
      />
    </div>
  );
}

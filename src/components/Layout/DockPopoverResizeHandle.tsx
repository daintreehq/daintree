import { cn } from "@/lib/utils";
import type { DockPopoverResizeHandleProps } from "./useDockPopoverResize";

interface Props {
  handleProps: DockPopoverResizeHandleProps;
  isResizing: boolean;
}

/**
 * Top-edge drag strip for resizing a dock popover. Anchored to the top of the
 * (positioned) PopoverContent; dragging it upward grows the bottom-anchored
 * popover. Visual idiom mirrors the Sidebar resize handle, rotated horizontal.
 */
export function DockPopoverResizeHandle({ handleProps, isResizing }: Props) {
  return (
    <div
      {...handleProps}
      className={cn(
        "group/resize absolute top-0 inset-x-0 h-2 z-20 flex items-center justify-center cursor-row-resize",
        // Neutral hover/focus differentiation — the accent is reserved for
        // load-bearing focus anchors, not a secondary resize affordance
        // (Accent Color Restraint). Keyboard focus is conveyed by the lifted
        // indicator line plus the neutral overlay.
        "hover:bg-overlay-soft transition-colors focus-visible:outline-hidden focus-visible:bg-overlay-medium",
        isResizing && "bg-overlay-medium"
      )}
    >
      <div
        className={cn(
          "w-8 h-px rounded-full transition-[height] duration-150 delay-100 group-hover/resize:h-0.5",
          "bg-daintree-text/20 group-hover/resize:bg-daintree-text/35 group-focus-visible/resize:bg-daintree-text/60 group-focus-visible/resize:h-0.5",
          isResizing && "bg-daintree-text/50"
        )}
      />
    </div>
  );
}

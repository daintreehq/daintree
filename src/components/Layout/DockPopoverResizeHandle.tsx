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
        // Hover stays neutral. Keyboard focus wears the same inset ring and
        // neutral lift as the sidebar and panel resize handles — the ring is
        // the focus anchor, not a second accent on the affordance itself.
        "outline-hidden transition-colors focus-visible:bg-overlay-medium",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
        // Hover styling is off while resizing, or it outranks the drag state.
        isResizing ? "bg-overlay-medium" : "hover:bg-overlay-soft"
      )}
    >
      <div
        className={cn(
          "w-8 rounded-full transition-[height] duration-150 delay-100",
          isResizing
            ? "h-0.5 bg-text-primary/50"
            : "h-px bg-text-primary/20 group-hover/resize:h-0.5 group-hover/resize:bg-text-primary/35 group-focus-visible/resize:bg-text-primary/60 group-focus-visible/resize:h-0.5"
        )}
      />
    </div>
  );
}

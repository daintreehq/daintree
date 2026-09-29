import { ResizeHandle } from "@/components/ui/ResizeHandle";
import type { DockPopoverResizeHandleProps } from "./useDockPopoverResize";

interface Props {
  handleProps: DockPopoverResizeHandleProps;
  isResizing: boolean;
}

/**
 * Top-edge drag strip for resizing a dock popover: the shared `ResizeHandle`, lining
 * the inside of the (positioned) PopoverContent's top edge. Dragging it upward grows
 * the bottom-anchored popover.
 */
export function DockPopoverResizeHandle({ handleProps, isResizing }: Props) {
  return (
    <ResizeHandle
      growKey="ArrowUp"
      edge="top"
      isResizing={isResizing}
      className="z-20"
      {...handleProps}
    />
  );
}

import type React from "react";
import { cn } from "@/lib/utils";
import { HELP_PANEL_MAX_WIDTH, HELP_PANEL_MIN_WIDTH } from "@/store/helpPanelStore";

interface HelpPanelResizeHandleProps {
  width: number;
  isResizing: boolean;
  isVisible: boolean;
  controlsId: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onReset: () => void;
}

/**
 * The assistant's left-edge splitter. It uses the same recipe as the sidebar, portal and
 * scratchpad handles (a 12px target straddling the edge, a neutral grip, the accent only
 * on keyboard focus) so every resizable edge in the app reads and resets the same way.
 */
export function HelpPanelResizeHandle({
  width,
  isResizing,
  isVisible,
  controlsId,
  onMouseDown,
  onKeyDown,
  onReset,
}: HelpPanelResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Daintree Assistant panel (double-click to reset)"
      aria-controls={controlsId}
      aria-valuenow={width}
      aria-valuemin={HELP_PANEL_MIN_WIDTH}
      aria-valuemax={HELP_PANEL_MAX_WIDTH}
      tabIndex={isVisible ? 0 : -1}
      data-testid="help-panel-resize"
      className={cn(
        "group absolute -left-1.5 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center",
        "transition-colors outline-hidden focus-visible:bg-overlay-medium focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        // Hover styling is off while resizing, or it outranks the drag state.
        isResizing ? "bg-overlay-medium" : "hover:bg-overlay-soft"
      )}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <div
        className={cn(
          "h-8 rounded-full transition-[width] duration-150 delay-100",
          // The focus outline is the accent; the grip stays neutral.
          isResizing
            ? "w-0.5 bg-text-primary/50"
            : "w-px bg-text-primary/20 group-hover:w-0.5 group-hover:bg-text-primary/35 group-focus-visible:w-0.5 group-focus-visible:bg-text-primary/50"
        )}
      />
    </div>
  );
}

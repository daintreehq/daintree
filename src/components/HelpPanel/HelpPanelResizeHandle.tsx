import type React from "react";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
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
 * The assistant's left-edge splitter. Inset rather than straddling: the panel and the
 * wrapper that slides it both clip at the left border, which would halve the target.
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
    <ResizeHandle
      growKey="ArrowLeft"
      edge="left-inset"
      label="Resize Daintree Assistant panel"
      value={width}
      min={HELP_PANEL_MIN_WIDTH}
      max={HELP_PANEL_MAX_WIDTH}
      isResizing={isResizing}
      aria-controls={controlsId}
      tabIndex={isVisible ? 0 : -1}
      data-testid="help-panel-resize"
      className="z-10"
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onReset={onReset}
    />
  );
}

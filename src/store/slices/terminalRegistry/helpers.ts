import type { TerminalFlowStatus, TerminalRuntimeStatus, TerminalType } from "@/types";
import type { PanelKind } from "@/types";
import { getDefaultPanelTitle } from "@shared/config/panelKindRegistry";
import { ABSOLUTE_MAX_GRID_TERMINALS } from "@/lib/terminalLayout";

// Re-export for backward compatibility
export const MAX_GRID_TERMINALS = ABSOLUTE_MAX_GRID_TERMINALS;

// Dock geometry constants
export const DOCK_WIDTH = 700;
export const DOCK_HEIGHT = 500;
export const HEADER_HEIGHT = 32;
export const PADDING_X = 24;
export const PADDING_Y = 24;

export const DOCK_TERM_WIDTH = DOCK_WIDTH - PADDING_X;
export const DOCK_TERM_HEIGHT = DOCK_HEIGHT - HEADER_HEIGHT - PADDING_Y;

// Reliability: keep PTY geometry optimistic even when docked to avoid hard-wrapping output.
// Dock previews are clipped rather than driving PTY resizes.
export const DOCK_PREWARM_WIDTH_PX = 1200;
export const DOCK_PREWARM_HEIGHT_PX = 800;

export const deriveRuntimeStatus = (
  isVisible: boolean | undefined,
  flowStatus?: TerminalFlowStatus,
  currentStatus?: TerminalRuntimeStatus
): TerminalRuntimeStatus => {
  if (currentStatus === "exited" || currentStatus === "error") {
    return currentStatus;
  }
  if (flowStatus && flowStatus !== "running") {
    return flowStatus;
  }
  if (isVisible === false) {
    return "background";
  }
  return "running";
};

export function getDefaultTitle(kind?: PanelKind, type?: TerminalType, agentId?: string): string {
  // Use panel kind registry for proper title resolution
  const effectiveKind = kind ?? (agentId ? "agent" : "terminal");
  return getDefaultPanelTitle(effectiveKind, agentId ?? (type !== "terminal" ? type : undefined));
}

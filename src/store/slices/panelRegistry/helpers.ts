import type { TerminalFlowStatus, TerminalRuntimeStatus } from "@/types";
import type { PanelKind } from "@/types";
import { getDefaultPanelTitle } from "@shared/config/panelKindRegistry";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { ABSOLUTE_MAX_GRID_TERMINALS } from "@/lib/terminalLayout";
import { resolveChromeAgentId, type ChromeIdentityInput } from "@/utils/agentIdentity";

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

/**
 * Compute the default title for a panel given its current chrome identity.
 * Returns the agent's display name while an agent is live/expected, and falls
 * back to the generic panel-kind title (usually "Terminal") otherwise.
 *
 * Callers must check `titleMode` themselves — this helper does not know
 * whether the user has renamed.
 */
export function getDefaultTitle(
  kind: PanelKind | undefined,
  identity?: ChromeIdentityInput
): string {
  const chromeAgentId = resolveChromeAgentId(identity);
  if (chromeAgentId && isBuiltInAgentId(chromeAgentId)) {
    return AGENT_REGISTRY[chromeAgentId]?.name ?? chromeAgentId;
  }
  return getDefaultPanelTitle(kind ?? "terminal");
}

export function stopDevPreviewByPanelId(panelId: string): void {
  if (typeof window === "undefined") return;
  const stopByPanel = window.electron?.devPreview?.stopByPanel;
  if (!stopByPanel) return;

  void stopByPanel({ panelId }).catch((error) => {
    console.error(
      `[TerminalStore] Failed to stop dev preview session for panel ${panelId}:`,
      error
    );
  });
}

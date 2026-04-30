import type { TerminalFlowStatus, TerminalRuntimeStatus } from "@/types";
import type { PanelKind } from "@/types";
import type { TabGroup } from "@/types";
import { getDefaultPanelTitle } from "@shared/config/panelKindRegistry";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { ABSOLUTE_MAX_GRID_TERMINALS } from "@/lib/terminalLayout";
import { deriveTerminalChrome, type TerminalChromeInput } from "@/utils/terminalChrome";
import { logError } from "@/utils/logger";

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

export function removePanelIdsFromTabGroups(
  tabGroups: Map<string, TabGroup>,
  panelIdsToRemove: ReadonlySet<string>
): { tabGroups: Map<string, TabGroup>; changed: boolean } {
  let changed = false;
  const nextTabGroups = new Map(tabGroups);

  for (const [groupId, group] of tabGroups) {
    if (!group.panelIds.some((panelId) => panelIdsToRemove.has(panelId))) continue;

    changed = true;
    const panelIds = group.panelIds.filter((panelId) => !panelIdsToRemove.has(panelId));
    if (panelIds.length <= 1) {
      nextTabGroups.delete(groupId);
      continue;
    }

    nextTabGroups.set(groupId, {
      ...group,
      panelIds,
      activeTabId: panelIds.includes(group.activeTabId) ? group.activeTabId : (panelIds[0] ?? ""),
    });
  }

  return { tabGroups: changed ? nextTabGroups : tabGroups, changed };
}

interface DefaultTitleIdentity extends TerminalChromeInput {
  launchAgentId?: string;
  everDetectedAgent?: boolean;
}

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
  identity?: DefaultTitleIdentity
): string {
  const chromeAgentId = deriveTerminalChrome({ kind, ...identity }).agentId;
  if (chromeAgentId && isBuiltInAgentId(chromeAgentId)) {
    return AGENT_REGISTRY[chromeAgentId]?.name ?? chromeAgentId;
  }
  if (
    identity?.launchAgentId &&
    identity.everDetectedAgent !== true &&
    isBuiltInAgentId(identity.launchAgentId)
  ) {
    return AGENT_REGISTRY[identity.launchAgentId]?.name ?? identity.launchAgentId;
  }
  return getDefaultPanelTitle(kind ?? "terminal");
}

export function stopDevPreviewByPanelId(panelId: string): void {
  if (typeof window === "undefined") return;
  const stopByPanel = window.electron?.devPreview?.stopByPanel;
  if (!stopByPanel) return;

  void stopByPanel({ panelId }).catch((error) => {
    logError(`[TerminalStore] Failed to stop dev preview session for panel ${panelId}`, error);
  });
}

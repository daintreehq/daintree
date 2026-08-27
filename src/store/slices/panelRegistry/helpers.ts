import type { PersistableFlowStatus, TerminalRuntimeStatus } from "@/types";
import type { PanelKind } from "@/types";
import type { TabGroup } from "@/types";
import { getDefaultPanelTitle } from "@shared/config/panelKindRegistry";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { ABSOLUTE_MAX_GRID_TERMINALS } from "@/lib/terminalLayout";
import { deriveTerminalChrome, type TerminalChromeInput } from "@/utils/terminalChrome";
import { logError, logWarn } from "@/utils/logger";
import { isPtyPanel } from "@shared/types/panel";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { terminalClient } from "@/clients";
import { getNarrowPanel } from "./selectors";

/**
 * Record a deliberate, user-initiated worktree filing on the lifecycle ledger.
 * No-ops when the panel has no live generation — the ledger validates writes
 * against the current generation and would reject a stale or absent one anyway.
 *
 * Lives here rather than beside either caller: both the single-panel move
 * (`restart.ts`) and the grouped move (`tabGroups.ts`) need it, and importing
 * one from the other would close a cycle.
 */
export function recordExplicitWorktreeAttribution(id: string, worktreeId: string): void {
  const generation = agentLifecycleLedger.currentGeneration(id);
  if (generation === undefined) return;
  agentLifecycleLedger.recordWorktreeAttribution(id, generation, worktreeId, "explicit");
}

/**
 * Mirror a worktree filing onto the pty-host terminal record, which is what the
 * fleet palette groups by. The renderer panel store is authoritative for what
 * the user sees; the pty-host copy is a downstream mirror that nothing else
 * re-stamps, so a move that skips this hop leaves the palette filing the run
 * under the worktree it launched in — or under "No worktree" (#12060).
 *
 * `null` is the explicit clear, for the one path that really does leave a panel
 * with no worktree: undoing a dock-to-grid move deletes the adopted id
 * (`layoutUndoStore`). Callers pass the panel's own value verbatim and never
 * substitute a root or an active worktree for an absent one.
 *
 * Lives here for the same reason `recordExplicitWorktreeAttribution` does: the
 * single-panel move (`restart.ts`), the grouped move (`tabGroups.ts`) and the
 * layout-undo restore all need it, and importing one from another would close a
 * cycle.
 */
export function syncWorktreeAttributionToHost(id: string, worktreeId: string | null): void {
  try {
    terminalClient.updateWorktreeId(id, worktreeId);
  } catch (error) {
    logWarn("[PanelRegistry] Failed to sync worktree filing to the pty host", { id, error });
  }
}

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/**
 * Count grid-visible panels currently in `agentState === "working"`. O(N) over
 * the panel registry, called from the `selectWorkingGridAgentCount` selector
 * to feed fleet-aware refresh-tier demotion (issue #8596). Excludes dock,
 * trash, backgrounded, and explicitly-hidden panels — they don't put visible
 * pressure on the renderer budget. Derived rather than maintained at
 * write-time because many listeners (`onAgentExited`, identity reducers,
 * restart paths) bypass `updateAgentState` and silently desync a counter.
 */
export function computeWorkingGridAgentCount(panelsById: Record<string, CarrierPanel>): number {
  let count = 0;
  for (const id in panelsById) {
    const t = panelsById[id];
    if (!t) continue;
    if (!isPtyPanel(t) || t.agentState !== "working") continue;
    const location = t.location ?? "grid";
    if (location !== "grid") continue;
    if (t.isVisible === false) continue;
    count++;
  }
  return count;
}

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
  flowStatus?: PersistableFlowStatus,
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

/**
 * Dissolve a single panel from its tab group. Returns a new Map (never mutates
 * the input) and a `dissolved` flag so callers can decide whether to persist.
 *
 * When the remaining panel count drops to 1 or 0 the group is deleted.
 * When the removed panel was the active tab, `activeTabId` falls back to the
 * first remaining panel.
 */
export function dissolvePanelFromGroup(
  tabGroups: Map<string, TabGroup>,
  panelId: string
): { tabGroups: Map<string, TabGroup>; dissolved: boolean } {
  for (const group of tabGroups.values()) {
    if (!group.panelIds.includes(panelId)) continue;

    const newPanelIds = group.panelIds.filter((pid) => pid !== panelId);
    const newTabGroups = new Map(tabGroups);

    if (newPanelIds.length <= 1) {
      newTabGroups.delete(group.id);
    } else {
      const newActiveTabId = newPanelIds.includes(group.activeTabId)
        ? group.activeTabId
        : (newPanelIds[0] ?? "");
      newTabGroups.set(group.id, {
        ...group,
        panelIds: newPanelIds,
        activeTabId: newActiveTabId,
      });
    }

    return { tabGroups: newTabGroups, dissolved: true };
  }

  return { tabGroups, dissolved: false };
}

/** Structural shape satisfied by both BackgroundedTerminal and TrashedTerminal
 *  at recreate call sites without merging the domain types. */
export interface RestorableTerminalRef {
  id: string;
  originalLocation?: "dock" | "grid";
  groupRestoreId?: string;
  groupMetadata?: import("./types").TrashedTerminalGroupMetadata;
}

/**
 * Compute the ordered panel IDs and active tab for a restored tab group.
 *
 * `anchorMetadata` is the `groupMetadata` from the anchor panel of the
 * dissolved group. If the anchor panel was removed independently,
 * `anchorMetadata` is undefined and the caller must fall back to the first
 * remaining panel's original metadata.
 *
 * Returns `null` when fewer than 2 valid panels remain (no group to recreate).
 */
export function computeRestoredTabGroup(
  validPanelIds: string[],
  anchorMetadata?: import("./types").TrashedTerminalGroupMetadata
): { orderedPanelIds: string[]; activeTabId: string } | null {
  if (validPanelIds.length <= 1) return null;

  let orderedPanelIds = [...validPanelIds];
  let activeTabId: string = validPanelIds[0]!;

  if (anchorMetadata) {
    const { panelIds, activeTabId: metadataActiveTabId } = anchorMetadata;
    orderedPanelIds = panelIds.filter((id) => validPanelIds.includes(id));
    for (const id of validPanelIds) {
      if (!orderedPanelIds.includes(id)) {
        orderedPanelIds.push(id);
      }
    }
    activeTabId = orderedPanelIds.includes(metadataActiveTabId)
      ? metadataActiveTabId
      : orderedPanelIds[0]!;
  }

  if (orderedPanelIds.length <= 1) return null;

  return { orderedPanelIds, activeTabId };
}

export function stopDevPreviewByPanelId(panelId: string): void {
  if (typeof window === "undefined") return;
  const stopByPanel = window.electron?.devPreview?.stopByPanel;
  if (!stopByPanel) return;

  void stopByPanel({ panelId }).catch((error) => {
    logError(`[TerminalStore] Failed to stop dev preview session for panel ${panelId}`, error);
  });
}

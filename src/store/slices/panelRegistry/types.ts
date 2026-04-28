import type { StoreApi } from "zustand";
import type {
  TerminalInstance as TerminalInstanceType,
  AgentState,
  AgentStateChangeTrigger,
  TerminalFlowStatus,
  TerminalRuntimeStatus,
  SpawnError,
  TerminalReconnectError,
  TabGroup,
  TabGroupLocation,
  BrowserHistory,
  AddPanelOptions,
} from "@/types";

export type TerminalInstance = TerminalInstanceType;
export type { AddPanelOptions };

export interface TrashedTerminalGroupMetadata {
  panelIds: string[];
  activeTabId: string;
  location: TabGroupLocation;
  worktreeId: string | null;
}

export interface TrashedTerminal {
  id: string;
  expiresAt: number;
  originalLocation: "dock" | "grid";
  /** Shared ID for panels trashed together as a group */
  groupRestoreId?: string;
  /** Present on the "anchor" panel of a trashed group, holds metadata for recreation */
  groupMetadata?: TrashedTerminalGroupMetadata;
}

export interface BackgroundedTerminal {
  id: string;
  originalLocation: "dock" | "grid";
  /** Shared ID for panels backgrounded together as a group */
  groupRestoreId?: string;
  /** Present on the "anchor" panel of a backgrounded group, holds metadata for recreation */
  groupMetadata?: TrashedTerminalGroupMetadata;
}

/**
 * Opaque token returned by `beginHydrationBatch`. Callers must pass the same token
 * to `flushHydrationBatch` so a stale batch from a cancelled hydration cannot be
 * flushed by a later, unrelated caller.
 */
export type HydrationBatchToken = symbol;

export interface PanelRegistrySlice {
  panelsById: Record<string, TerminalInstance>;
  panelIds: string[];
  trashedTerminals: Map<string, TrashedTerminal>;
  backgroundedTerminals: Map<string, BackgroundedTerminal>;
  /** Explicit tab group storage - single source of truth for tab membership and order */
  tabGroups: Map<string, TabGroup>;

  addPanel: (options: AddPanelOptions) => Promise<string | null>;
  /**
   * Hydration-only: collect subsequent `addPanel` mutations into one batched commit
   * instead of applying each individually. Every `addPanel` between begin and flush
   * still returns its final id and runs per-panel side effects, but store mutations
   * are deferred until `flushHydrationBatch` fires exactly one `set()` +
   * `saveNormalized()` for all collected panels. Collapses an N-panel restore phase
   * from N re-renders into 1.
   */
  beginHydrationBatch: () => HydrationBatchToken;
  /** Apply all panels collected since `beginHydrationBatch` in a single `set()` call. */
  flushHydrationBatch: (token: HydrationBatchToken) => void;
  removePanel: (id: string) => void;
  updateTitle: (id: string, newTitle: string) => void;
  updateLastObservedTitle: (id: string, title: string) => void;
  updateAgentState: (
    id: string,
    agentState: AgentState,
    error?: string,
    lastStateChange?: number,
    trigger?: AgentStateChangeTrigger,
    confidence?: number,
    waitingReason?: import("@shared/types/agent.js").WaitingReason,
    sessionCost?: number,
    sessionTokens?: number
  ) => void;
  updateActivity: (
    id: string,
    headline: string,
    status: "working" | "waiting" | "success" | "failure",
    type: "interactive" | "background" | "idle",
    timestamp: number,
    lastCommand?: string
  ) => void;
  updateLastCommand: (id: string, lastCommand: string) => void;
  updateVisibility: (id: string, isVisible: boolean) => void;
  getTerminal: (id: string) => TerminalInstance | undefined;

  moveTerminalToDock: (id: string) => void;
  moveTerminalToGrid: (id: string) => boolean;
  toggleTerminalLocation: (id: string) => void;

  trashPanel: (id: string) => void;
  /** Trash all panels in a group together, storing group metadata for restoration */
  trashPanelGroup: (panelId: string) => void;
  restoreTerminal: (id: string, targetWorktreeId?: string) => void;
  /** Restore all panels with the given groupRestoreId, recreating the tab group */
  restoreTrashedGroup: (groupRestoreId: string, targetWorktreeId?: string) => void;
  markAsTrashed: (id: string, expiresAt: number, originalLocation: "dock" | "grid") => void;
  markAsRestored: (id: string) => void;
  isInTrash: (id: string) => boolean;

  backgroundTerminal: (id: string) => void;
  /** Background all panels in a group together, storing group metadata for restoration */
  backgroundPanelGroup: (panelId: string) => void;
  restoreBackgroundTerminal: (id: string, targetWorktreeId?: string) => void;
  /** Restore all panels with the given groupRestoreId, recreating the tab group */
  restoreBackgroundGroup: (groupRestoreId: string, targetWorktreeId?: string) => void;
  isInBackground: (id: string) => boolean;

  reorderTerminals: (
    fromIndex: number,
    toIndex: number,
    location?: "grid" | "dock",
    worktreeId?: string | null
  ) => void;
  moveTerminalToPosition: (
    id: string,
    toIndex: number,
    location: "grid" | "dock",
    worktreeId?: string | null
  ) => void;
  restoreTerminalOrder: (orderedIds: string[]) => void;

  restartTerminal: (id: string) => Promise<void>;
  clearTerminalError: (id: string) => void;
  updateTerminalCwd: (id: string, cwd: string) => void;
  moveTerminalToWorktree: (id: string, worktreeId: string) => void;
  moveToNewWorktreeAndTransfer: (id: string) => void;
  updateFlowStatus: (id: string, status: TerminalFlowStatus, timestamp: number) => void;
  setRuntimeStatus: (id: string, status: TerminalRuntimeStatus) => void;
  setInputLocked: (id: string, locked: boolean) => void;
  toggleInputLocked: (id: string) => void;
  /**
   * Kill the current PTY and respawn it in the same panel slot using a
   * different preset. Fires as part of the fallback chain when a preset's
   * provider is unavailable. No session resume (fresh spawn), since the
   * upstream session we were talking to is the very thing that failed.
   */
  activateFallbackPreset: (
    id: string,
    nextPresetId: string,
    originalPresetId: string
  ) => Promise<{ success: boolean; error?: string }>;
  setBrowserUrl: (id: string, url: string) => void;
  setBrowserHistory: (id: string, history: BrowserHistory) => void;
  setBrowserZoom: (id: string, zoom: number) => void;
  setBrowserConsoleOpen: (id: string, isOpen: boolean) => void;
  setDevPreviewConsoleOpen: (id: string, isOpen: boolean) => void;
  setViewportPreset: (
    id: string,
    preset: import("@shared/types/panel.js").ViewportPresetId | undefined
  ) => void;
  setDevPreviewScrollPosition: (
    id: string,
    position: { url: string; scrollY: number } | undefined
  ) => void;
  setDevServerState: (
    id: string,
    status: "stopped" | "starting" | "installing" | "running" | "error",
    url: string | null,
    error: { type: string; message: string } | null,
    terminalId: string | null
  ) => void;
  setSpawnError: (id: string, error: SpawnError) => void;
  clearSpawnError: (id: string) => void;
  setReconnectError: (id: string, error: TerminalReconnectError) => void;
  clearReconnectError: (id: string) => void;

  // Tab grouping methods - TabGroup is the single source of truth
  /** Get all panels in a group, ordered by group's panelIds array. Location param is deprecated. */
  getTabGroupPanels: (groupId: string, location?: TabGroupLocation) => TerminalInstance[];
  /** Get all tab groups for a location/worktree */
  getTabGroups: (location: TabGroupLocation, worktreeId?: string) => TabGroup[];
  /** Get the group a panel belongs to, if any */
  getPanelGroup: (panelId: string) => TabGroup | undefined;
  /** Create a new tab group with initial panels */
  createTabGroup: (
    location: TabGroupLocation,
    worktreeId: string | undefined,
    panelIds: string[],
    activeTabId?: string
  ) => string;
  /** Add a panel to an existing group at optional index */
  addPanelToGroup: (groupId: string, panelId: string, index?: number) => void;
  /** Remove a panel from its group (group deleted if only 1 panel remains) */
  removePanelFromGroup: (panelId: string) => void;
  /** Reorder panels within a group */
  reorderPanelsInGroup: (groupId: string, panelIds: string[]) => void;
  /** Delete a tab group (panels become ungrouped) */
  deleteTabGroup: (groupId: string) => void;
  /** Move an entire tab group to a new location (grid/dock), updating all member panels */
  moveTabGroupToLocation: (groupId: string, location: TabGroupLocation) => boolean;
  /** Move an entire tab group to a new worktree, updating all member panels */
  moveTabGroupToWorktree: (groupId: string, worktreeId: string) => boolean;
  /** Reorder tab groups within a location. Moves all panels in each group together. */
  reorderTabGroups: (
    fromGroupIndex: number,
    toGroupIndex: number,
    location: TabGroupLocation,
    worktreeId?: string | null
  ) => void;
  /** Set the active tab for a tab group (single source of truth) */
  setActiveTab: (groupId: string, panelId: string) => void;
  /** Get the active tab ID for a tab group, returns null if not found */
  getActiveTabId: (groupId: string) => string | null;
  /** Hydrate tab groups from persisted state, sanitizing invalid data */
  hydrateTabGroups: (tabGroups: TabGroup[], options?: { skipPersist?: boolean }) => void;
  /** @deprecated Use createTabGroup/addPanelToGroup instead */
  setTabGroupInfo: (
    id: string,
    tabGroupId: string | undefined,
    orderInGroup: number | undefined
  ) => void;
}

export type PanelRegistryMiddleware = {
  onTerminalRemoved?: (
    id: string,
    removedIndex: number,
    remainingIds: string[],
    removedTerminal: TerminalInstance | undefined
  ) => void;
};

export type PanelRegistryStoreApi = StoreApi<PanelRegistrySlice>;

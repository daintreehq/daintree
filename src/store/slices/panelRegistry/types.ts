import type { StoreApi } from "zustand";
import type {
  AgentState,
  AgentStateChangeTrigger,
  PersistableFlowStatus,
  TerminalRuntimeStatus,
  SpawnError,
  TerminalReconnectError,
  TerminalScrollbackRestoreError,
  TabGroup,
  TabGroupLocation,
  BrowserHistory,
  AddPanelOptions,
} from "@/types";
import type { PanelInstance } from "@shared/types/panel";

export type { AddPanelOptions };

/**
 * Options accepted by `restartTerminal`. Opaque defaults match existing
 * behaviour; flags are opt-in for specific callers whose intent differs from
 * the standard graceful-restart flow.
 */
export interface RestartTerminalOptions {
  /**
   * When `false`, suppresses session continuity from the kill: the session id
   * captured by the graceful shutdown is discarded and the "resume the most
   * recent session" fallback is skipped even if the agent declares
   * `resumeLatestArgs`. Used by `moveToNewWorktreeAndTransfer` where the CWD
   * has changed and a fresh launch with buffer-injected context is
   * intentional — silently resuming a session in the new CWD would mask the
   * move and double up the injected history. A session id already stored on
   * the panel still resumes exactly (pre-existing contract; the update-cwd
   * flow relies on it). See issue #4781 for the cross-worktree-transfer
   * rationale.
   * Defaults to `true` (resume enabled).
   */
  allowResumeLatest?: boolean;
}

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
  /** Replicated on every member of a trashed group, holds metadata for recreation */
  groupMetadata?: TrashedTerminalGroupMetadata;
}

export interface BackgroundedTerminal {
  id: string;
  originalLocation: "dock" | "grid";
  /** Shared ID for panels backgrounded together as a group */
  groupRestoreId?: string;
  /** Replicated on every member of a backgrounded group, holds metadata for recreation */
  groupMetadata?: TrashedTerminalGroupMetadata;
}

/**
 * Opaque token returned by `beginHydrationBatch`. Callers must pass the same token
 * to `flushHydrationBatch` so a stale batch from a cancelled hydration cannot be
 * flushed by a later, unrelated caller.
 */
export type HydrationBatchToken = symbol;

export interface PanelRegistrySlice {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
  /**
   * Per-worktree panel id buckets, maintained at write time (add/remove/transfer)
   * so per-row selectors can scope work to one worktree's panels in O(1) without
   * scanning all `panelIds` on every per-terminal field tick. Bucket key for
   * panels with no worktree is the literal "__none__". See issue #7451.
   */
  panelIdsByWorktreeId: Record<string, string[]>;
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
  /**
   * Recipe/worktree spawn variant of {@link beginHydrationBatch}. Reuses the same
   * single-commit machinery so an N-panel recipe run collapses to one `panelIds`
   * render (one CSS Grid reflow) instead of N. Unlike hydration, it refuses to
   * supersede an already-active batch (returns `null`) because recipe runs can
   * overlap; a `null` token is a safe no-op at flush time. See issue #9165.
   */
  beginSpawnBatch: () => HydrationBatchToken | null;
  /** Apply all panels collected since `beginSpawnBatch` in a single `set()`. No-op for a `null` token. */
  flushSpawnBatch: (token: HydrationBatchToken | null) => void;
  removePanel: (id: string) => void;
  emptyTrash: (ids: string[]) => void;
  /**
   * Rename a panel. `source` is the ownership rung doing the write: `"user"`
   * (default — inline editors, rename dialog) locks the title as
   * `titleMode: "user"`; `"automation"` (MCP/assistant `terminal.rename`)
   * writes `titleMode: "custom"` and is a no-op against a user lock. An empty
   * `newTitle` resets to the identity-derived default and unlocks.
   */
  updateTitle: (id: string, newTitle: string, source?: "user" | "automation") => void;
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
    lastCommand?: string
  ) => void;
  updateLastCommand: (id: string, lastCommand: string) => void;
  updateVisibility: (id: string, isVisible: boolean) => void;
  /**
   * Stamp `lastActiveAt = Date.now()` on the panel. Called from user-intent
   * focus paths (`setFocused`, `activateTerminal`, `openDockTerminal`) so
   * panel restore can promote the most-recently-active panel per worktree
   * to the priority tier. Idempotent on missing panels.
   */
  stampLastActive: (id: string) => void;
  getTerminal: (id: string) => PanelInstance | undefined;

  moveTerminalToDock: (id: string) => void;
  moveTerminalToGrid: (id: string) => boolean;
  /**
   * Promote a `location: "dialog"` panel into the grid, keeping the same panel
   * id so the content the user is already reading carries over intact.
   *
   * Distinct from `moveTerminalToGrid`, which is a pure layout move with no
   * admission check (#8805 removed the grid's fit cap). A dialog panel was
   * never counted against the panel limit, so promoting it genuinely admits a
   * new panel — this re-checks the hard ceiling and clears the ephemeral
   * `excludeFromPersistence` flag in the same atomic commit.
   *
   * Returns false (leaving state untouched) if the panel is missing, is not a
   * dialog panel, or the hard limit is already reached.
   */
  promoteDialogPanelToGrid: (id: string) => boolean;
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

  restartTerminal: (id: string, options?: RestartTerminalOptions) => Promise<void>;
  clearTerminalError: (id: string) => void;
  updateTerminalCwd: (id: string, cwd: string) => void;
  moveTerminalToWorktree: (id: string, worktreeId: string) => void;
  moveToNewWorktreeAndTransfer: (id: string) => void;
  updateFlowStatus: (id: string, status: PersistableFlowStatus, timestamp: number) => void;
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
  setDevPreviewConsoleTab: (id: string, tab: "output" | "console" | "diagnostics") => void;
  setViewportPreset: (
    id: string,
    preset: import("@shared/types/panel.js").ViewportPresetId | undefined
  ) => void;
  setViewportRotated: (id: string, rotated: boolean) => void;
  setViewportDpr: (id: string, dpr: 1 | 2 | 3) => void;
  setViewportFit: (id: string, fit: boolean) => void;
  setDevPreviewScrollPosition: (
    id: string,
    position: { url: string; scrollY: number } | undefined
  ) => void;
  setFilePanelPath: (id: string, filePath: string) => void;
  setFileViewMode: (id: string, viewMode: import("@shared/types/panel.js").FileViewMode) => void;
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
  setScrollbackRestoreError: (id: string, error: TerminalScrollbackRestoreError) => void;
  clearScrollbackRestoreError: (id: string) => void;

  // Tab grouping methods - TabGroup is the single source of truth
  /** Get all panels in a group, ordered by group's panelIds array. Location param is deprecated. */
  getTabGroupPanels: (groupId: string, location?: TabGroupLocation) => PanelInstance[];
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
  /** Add a panel to an existing group at optional index. Returns true if the panel is a member after the call, false if the add was rejected (missing group/panel, worktree mismatch). */
  addPanelToGroup: (groupId: string, panelId: string, index?: number) => boolean;
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
    removedTerminal: PanelInstance | undefined
  ) => void;
};

export type PanelRegistryStoreApi = StoreApi<PanelRegistrySlice>;

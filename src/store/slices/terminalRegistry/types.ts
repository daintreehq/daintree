import type { StoreApi } from "zustand";
import type {
  TerminalInstance as TerminalInstanceType,
  AgentState,
  TerminalType,
  TerminalLocation,
  AgentStateChangeTrigger,
  TerminalFlowStatus,
  TerminalRuntimeStatus,
  SpawnError,
  PanelExitBehavior,
  TerminalReconnectError,
  TabGroup,
  TabGroupLocation,
} from "@/types";
import type { PanelKind } from "@/types";

export type TerminalInstance = TerminalInstanceType;

export interface AddTerminalOptions {
  kind?: PanelKind;
  type?: TerminalType;
  /** Agent ID when type is an agent - enables extensibility for new agents */
  agentId?: string;
  title?: string;
  worktreeId?: string;
  cwd: string;
  shell?: string;
  command?: string;
  location?: TerminalLocation;
  agentState?: AgentState;
  lastStateChange?: number;
  /** If provided, request a stable ID when spawning a new backend process */
  requestedId?: string;
  /** If provided, reconnect to existing backend process instead of spawning */
  existingId?: string;
  /** Store command on instance but don't execute it on spawn */
  skipCommandExecution?: boolean;
  /** Restore input lock state (read-only monitor mode) */
  isInputLocked?: boolean;
  /** Initial URL for browser panes (kind === 'browser') */
  browserUrl?: string;
  /** Path to note file (kind === 'notes') */
  notePath?: string;
  /** Note ID (kind === 'notes') */
  noteId?: string;
  /** Note scope (kind === 'notes') */
  scope?: "worktree" | "project";
  /** Note creation timestamp (kind === 'notes') */
  createdAt?: number;
  /** Dev server command override for dev-preview panels (kind === 'dev-preview') */
  devCommand?: string;
  /** Environment variables to set for this terminal */
  env?: Record<string, string>;
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely */
  exitBehavior?: PanelExitBehavior;
  // Note: Tab membership is now managed via createTabGroup/addPanelToGroup, not on terminals
}

export interface TrashedTerminal {
  id: string;
  expiresAt: number;
  originalLocation: "dock" | "grid";
}

export interface TerminalRegistrySlice {
  terminals: TerminalInstance[];
  trashedTerminals: Map<string, TrashedTerminal>;
  /** Explicit tab group storage - single source of truth for tab membership and order */
  tabGroups: Map<string, TabGroup>;

  addTerminal: (options: AddTerminalOptions) => Promise<string>;
  removeTerminal: (id: string) => void;
  updateTitle: (id: string, newTitle: string) => void;
  updateAgentState: (
    id: string,
    agentState: AgentState,
    error?: string,
    lastStateChange?: number,
    trigger?: AgentStateChangeTrigger,
    confidence?: number
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

  trashTerminal: (id: string) => void;
  restoreTerminal: (id: string, targetWorktreeId?: string) => void;
  markAsTrashed: (id: string, expiresAt: number, originalLocation: "dock" | "grid") => void;
  markAsRestored: (id: string) => void;
  isInTrash: (id: string) => boolean;

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

  restartTerminal: (id: string) => Promise<void>;
  clearTerminalError: (id: string) => void;
  updateTerminalCwd: (id: string, cwd: string) => void;
  moveTerminalToWorktree: (id: string, worktreeId: string) => void;
  updateFlowStatus: (id: string, status: TerminalFlowStatus, timestamp: number) => void;
  setRuntimeStatus: (id: string, status: TerminalRuntimeStatus) => void;
  setInputLocked: (id: string, locked: boolean) => void;
  toggleInputLocked: (id: string) => void;
  convertTerminalType: (id: string, newType: TerminalType, newAgentId?: string) => Promise<void>;
  setBrowserUrl: (id: string, url: string) => void;
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
  /** Hydrate tab groups from persisted state, sanitizing invalid data */
  hydrateTabGroups: (tabGroups: TabGroup[], options?: { skipPersist?: boolean }) => void;
  /** @deprecated Use createTabGroup/addPanelToGroup instead */
  setTabGroupInfo: (
    id: string,
    tabGroupId: string | undefined,
    orderInGroup: number | undefined
  ) => void;
}

export type TerminalRegistryMiddleware = {
  onTerminalRemoved?: (
    id: string,
    removedIndex: number,
    remainingTerminals: TerminalInstance[]
  ) => void;
};

export type TerminalRegistryStoreApi = StoreApi<TerminalRegistrySlice>;

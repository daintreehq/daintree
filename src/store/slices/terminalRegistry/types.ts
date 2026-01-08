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
}

export interface TrashedTerminal {
  id: string;
  expiresAt: number;
  originalLocation: "dock" | "grid";
}

export interface TerminalRegistrySlice {
  terminals: TerminalInstance[];
  trashedTerminals: Map<string, TrashedTerminal>;

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
}

export type TerminalRegistryMiddleware = {
  onTerminalRemoved?: (
    id: string,
    removedIndex: number,
    remainingTerminals: TerminalInstance[]
  ) => void;
};

export type TerminalRegistryStoreApi = StoreApi<TerminalRegistrySlice>;

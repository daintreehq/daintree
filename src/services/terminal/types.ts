import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { TerminalRefreshTier, TerminalType, TerminalKind, AgentState } from "@/types";

export type RefreshTierProvider = () => TerminalRefreshTier;

export type ResizeJobId = { type: "timeout"; id: number } | { type: "idle"; id: number };

export type AgentStateCallback = (state: AgentState) => void;

export interface ManagedTerminal {
  terminal: Terminal;
  type: TerminalType;
  kind?: TerminalKind;
  agentId?: string;
  agentState?: AgentState;
  agentStateSubscribers: Set<AgentStateCallback>;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
  imageAddon: ImageAddon;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable;
  hostElement: HTMLDivElement;
  isOpened: boolean;
  listeners: Array<() => void>;
  exitSubscribers: Set<(exitCode: number) => void>;
  parserHandler?: { dispose: () => void; setAllowResets?: (allow: boolean) => void };
  getRefreshTier: RefreshTierProvider;
  keyHandlerInstalled: boolean;
  lastAttachAt: number;
  lastDetachAt: number;
  // Visibility tracking
  isVisible: boolean;
  lastActiveTime: number;
  // Geometry caching for resize optimization
  lastWidth: number;
  lastHeight: number;
  // Renderer policy hysteresis state
  lastAppliedTier?: TerminalRefreshTier; // The tier currently in effect
  pendingTier?: TerminalRefreshTier; // Target tier for scheduled downgrade
  tierChangeTimer?: number;
  // Resize debouncing state
  resizeXJob?: ResizeJobId;
  resizeYJob?: ResizeJobId;
  lastYResizeTime: number;
  latestCols: number;
  latestRows: number;
  latestWasAtBottom: boolean;
  isUserScrolledBack: boolean;

  // Focus state
  isFocused: boolean;

  // Render backpressure / synchronization hints
  pendingWrites?: number;
  needsWake?: boolean;

  // Typing burst timer
  inputBurstTimer?: number;

  // Input lock state (read-only monitor mode)
  isInputLocked?: boolean;

  // Incremental restore state
  writeChain: Promise<void>;
  restoreGeneration: number;
  isSerializedRestoreInProgress: boolean;
  deferredOutput: Array<string | Uint8Array>;
}

export const TIER_DOWNGRADE_HYSTERESIS_MS = 500;

export const INCREMENTAL_RESTORE_CONFIG = {
  chunkBytes: 32768,
  timeBudgetMs: 10,
  indicatorThresholdBytes: 262144,
} as const;

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { TerminalRefreshTier, TerminalType, TerminalKind, AgentState } from "@/types";

export type RefreshTierProvider = () => TerminalRefreshTier;

export type ResizeJobId = { type: "timeout"; id: number } | { type: "idle"; id: number };

export interface ThrottledWriter {
  readonly pendingWrites: number;
  write: (data: string | Uint8Array) => void;
  dispose: () => void;
  updateProvider: (provider: RefreshTierProvider) => void;
  notifyInput: () => void;
  getDebugInfo: () => {
    tierName: string;
    fps: number;
    isBurstMode: boolean;
    effectiveDelay: number;
    bufferSize: number;
    pendingWrites: number;
  };
  boost: () => void;
  clear: () => void;
}

export type AgentStateCallback = (state: AgentState) => void;

export interface ManagedTerminal {
  terminal: Terminal;
  type: TerminalType;
  kind?: TerminalKind;
  agentId?: string;
  agentState?: AgentState;
  agentStateSubscribers: Set<AgentStateCallback>;
  fitAddon: FitAddon;
  webglAddon?: WebglAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
  imageAddon: ImageAddon;
  searchAddon: SearchAddon;
  hostElement: HTMLDivElement;
  isOpened: boolean;
  listeners: Array<() => void>;
  exitSubscribers: Set<(exitCode: number) => void>;
  outputSubscribers: Set<() => void>; // For tall canvas scroll sync
  throttledWriter: ThrottledWriter;
  getRefreshTier: RefreshTierProvider;
  keyHandlerInstalled: boolean;
  lastAttachAt: number;
  lastDetachAt: number;
  webglRecoveryAttempts: number;
  webglRecoveryToken?: number;
  // Visibility-aware LRU tracking
  isVisible: boolean;
  lastActiveTime: number;
  hasWebglError: boolean;
  // Geometry caching for resize optimization
  lastWidth: number;
  lastHeight: number;
  // WebGL dispose grace period timer
  webglDisposeTimer?: number;
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
  // Focus-aware scrolling state
  isFocused: boolean;
  // Tall canvas mode (agent terminals)
  isTallCanvas: boolean;
  // Effective row count for tall canvas (may be less than TALL_CANVAS_ROWS due to DPI limits)
  effectiveTallRows: number;
  // Callback for tall canvas scroll sync
  tallCanvasScrollToRow?: (row: number) => void;
  // Persisted scroll state for tall canvas (survives component remounts)
  tallCanvasFollowLog: boolean;
  tallCanvasLastScrollTop: number;
}

export type SabFlushMode = "normal" | "frame";

export const MAX_WEBGL_RECOVERY_ATTEMPTS = 4;
export const WEBGL_DISPOSE_GRACE_MS = 10000;
export const TIER_DOWNGRADE_HYSTERESIS_MS = 500;

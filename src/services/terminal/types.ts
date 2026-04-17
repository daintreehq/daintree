import { Terminal, IDisposable, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { TerminalRefreshTier, TerminalType, PanelKind, AgentState } from "@/types";

export type RefreshTierProvider = () => TerminalRefreshTier;

export type AgentStateCallback = (state: AgentState) => void;

export type PostCompleteHook = (output: string) => void | Promise<void>;

export interface ManagedTerminal {
  terminal: Terminal;
  type: TerminalType;
  kind?: PanelKind;
  agentId?: string;
  agentState?: AgentState;
  agentStateSubscribers: Set<AgentStateCallback>;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  imageAddon: ImageAddon | null;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable | null;
  webLinksAddon: WebLinksAddon | null;
  hostElement: HTMLDivElement;
  isOpened: boolean;
  listeners: Array<() => void>;
  exitSubscribers: Set<(exitCode: number) => void>;
  parserHandler?: { dispose: () => void };
  getRefreshTier: RefreshTierProvider;
  keyHandlerInstalled: boolean;
  lastAttachAt: number;
  lastDetachAt: number;
  // Last time forceXtermReflow() ran for this terminal — used to throttle the
  // IntersectionObserver unpause reflow across write/heartbeat/focus triggers.
  lastReflowAt?: number;
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
  // Resize scheduling state
  resizeJob?: AbortController;
  resizeDebounceTimer?: number;
  latestCols: number;
  latestRows: number;
  latestWasAtBottom: boolean;
  isUserScrolledBack: boolean;

  // Viewport pinning: suppress scroll tracking during programmatic scrollToBottom
  _suppressScrollTracking?: boolean;
  // Viewport pinning: set by wheel/keyboard events to distinguish user-initiated scroll
  _userScrollIntent?: boolean;

  // Last activity marker for scroll-to-last-activity
  lastActivityMarker?: IMarker;

  // Post-complete hook: one-shot callback fired on working → waiting transition
  postCompleteHook?: PostCompleteHook;
  postCompleteMarker?: IMarker;

  // Project-switch resize suppression
  resizeSuppressionTimer?: number;
  isResizeSuppressed?: boolean;
  resizeSuppressionEndTime?: number;
  targetCols?: number;
  targetRows?: number;
  isAttaching?: boolean;

  // Focus state
  isFocused: boolean;

  // Render backpressure / synchronization hints
  pendingWrites?: number;
  needsWake?: boolean;

  // Typing burst timer
  inputBurstTimer?: number;

  // Directing state: renderer-only ephemeral state for user typing into waiting agent
  canonicalAgentState?: AgentState;

  // Title-based state detection hysteresis (per-terminal)
  titleReportTimer?: number;
  pendingTitleState?: "working" | "waiting";

  // Last-meaningful-title tracking for agent session history
  observedTitleTimer?: number;
  pendingObservedTitle?: string;
  lastObservedTitleSent?: string;

  // Input lock state (read-only monitor mode)
  isInputLocked?: boolean;

  // Caller-supplied input callback (stored for reinstallation after hibernation wake)
  onInput?: (data: string) => void;

  // Incremental restore state
  writeChain: Promise<void>;
  restoreGeneration: number;
  isSerializedRestoreInProgress: boolean;
  deferredOutput: Array<string | Uint8Array>;

  // Deferred scrollback restore state — prevents double-restore and tracks lifecycle
  scrollbackRestoreState: "none" | "pending" | "in-progress" | "done";
  scrollbackRestoreDisposable?: { dispose: () => void };

  // Alternate screen buffer state (tracked via xterm.js onBufferChange).
  // Used to adapt UI (remove padding) and resize strategy for TUI applications.
  isAltBuffer?: boolean;
  altBufferListeners: Set<(isAltBuffer: boolean) => void>;

  // Project-switch detach state: instance is alive but not in any visible container
  isDetached?: boolean;

  // Attach generation: monotonic counter incremented on each attach().
  // Used to detect stale unmount cleanup from a previous mount site.
  attachGeneration: number;

  // Attach-reveal: hide terminal during reparent, reveal after render
  attachRevealToken: number;
  attachRevealTimer?: ReturnType<typeof setTimeout>;
  attachRevealDisposable?: { dispose: () => void };

  // Hibernation: xterm.js Terminal instance disposed to free memory
  isHibernated?: boolean;
  hibernationTimer?: ReturnType<typeof setTimeout>;
  ipcListenerCount: number;
}

export const TIER_DOWNGRADE_HYSTERESIS_MS = 500;

export const HIBERNATION_DELAY_MS = 30_000;

export const INCREMENTAL_RESTORE_CONFIG = {
  chunkBytes: 32768,
  timeBudgetMs: 10,
  indicatorThresholdBytes: 262144,
} as const;

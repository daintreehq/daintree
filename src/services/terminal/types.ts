import { Terminal, IDisposable, IMarker, ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { TerminalRefreshTier, PanelKind, AgentState } from "@/types";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";

export type RefreshTierProvider = () => TerminalRefreshTier;

/**
 * A hovered terminal link, tagged with a structural discriminant so the
 * right-click context menu can tell a resolved file-path link (`kind: "file"`,
 * carrying the resolved `absolutePath`) from a plain URL / OSC 8 link
 * (`kind: "url"`). Avoids an `instanceof FileLink` check across the addon/service
 * module boundary. `hoveredLink` is polymorphic — real `FileLink` instances from
 * FileLinksAddon and synthetic link objects for URLs both land here.
 */
export interface TerminalLink extends ILink {
  kind: "file" | "url";
  /** Resolved absolute path — present only when `kind === "file"`. */
  absolutePath?: string;
}

export type AgentStateCallback = (state: AgentState) => void;

export type PostCompleteHook = (output: string) => void | Promise<void>;

export interface ManagedTerminal {
  /** Stable terminal id — the key this instance is registered under. */
  id: string;
  terminal: Terminal;
  kind?: PanelKind;
  /** Launch hint — agent this terminal was launched to run. Not identity. */
  launchAgentId?: string;
  /** Live runtime agent identity. Set by detector promotion, cleared on demotion. */
  runtimeAgentId?: string;
  agentState?: AgentState;
  agentStateSubscribers: Set<AgentStateCallback>;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  imageAddon: ImageAddon | null;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable | null;
  imageLinksDisposable: IDisposable | null;
  webLinksAddon: WebLinksAddon | null;
  // Currently-hovered link (tracked via xterm addon hover/leave callbacks).
  // Read synchronously by the right-click context menu so it reflects the
  // same detection xterm uses for plain URLs, file paths, and OSC 8 links.
  hoveredLink: TerminalLink | null;
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
  // Last time the reconciliation watchdog issued a repair for this terminal —
  // per-terminal cooldown so a persistently-diverging layer never repair-loops.
  lastWatchdogRepairAt?: number;
  // Circuit breaker for the watchdog's geometry-convergence repair (#10909).
  // The cooldown only SPACES repairs; it doesn't CAP them, so a pane whose
  // proposeDimensions() never converges (e.g. a stable off-by-one column) would
  // re-wrap its full scrollback every cooldown window forever. These fields bound
  // that: count consecutive issued geometry repairs, trip after
  // WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS, and log the give-up exactly once.
  geometryRepairAttempts?: number;
  // Once tripped, the geometry branch stops issuing repairs (other repair layers
  // still run). Cleared when the grid converges again or the terminal re-attaches.
  geometryRepairGaveUp?: boolean;
  // The attachGeneration the counter accrued under — a fresh incarnation reusing
  // the same id must not inherit a prior instance's give-up state (mirrors the
  // revealPendingGeneration guard).
  geometryRepairGeneration?: number;
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
  // Timestamp of the most recent wheel event on the host element — used to
  // suppress the "new output" indicator while the user is actively scrolling.
  lastWheelAt?: number;

  // Timestamp of the most recent completed terminal.write() parse. Used by the
  // WebGL pool eviction scorer to protect terminals in an active write burst
  // even when pendingWrites has since drained to 0. Stamped on write-complete,
  // not write-enqueue, so it tracks rendered output rather than queue depth.
  lastWriteAt?: number;

  // Last activity marker for scroll-to-last-activity
  lastActivityMarker?: IMarker;

  // Post-complete hook: one-shot callback fired on working → waiting transition
  postCompleteHook?: PostCompleteHook;
  postCompleteMarker?: IMarker;

  // Project-switch resize suppression
  resizeSuppressionTimer?: number;
  isResizeSuppressed?: boolean;
  resizeSuppressionEndTime?: number;
  // A background resize that arrived while the resize lock was held (e.g. during
  // the project-switch suppression window). Stashed here and replayed when the
  // lock releases, so a window resize that lands mid-suppression isn't dropped.
  pendingBackgroundResize?: { width: number; height: number };
  // Reveal-pending guaranteed redraw (#10632). Set true when the project-switch
  // resize-suppression window clears while the host is NOT foreground-renderable
  // (still detached/occluded behind the warm anti-flash bridge on a long dwell):
  // the one-shot `resetRenderer` recovery can't run on a zero-box host without
  // self-skipping, so the obligation is handed to the reconciliation watchdog,
  // which runs the alt-buffer-safe atomic repair once DOM geometry proves the
  // pane on-screen. Owned by `revealPendingGeneration` (the attachGeneration at
  // arm time); cleared only by a successful reconcile or terminal destruction.
  revealPendingRepair?: boolean;
  revealPendingGeneration?: number;
  targetCols?: number;
  targetRows?: number;
  isAttaching?: boolean;

  // Focus state
  isFocused: boolean;

  // Render backpressure / synchronization hints
  pendingWrites?: number;
  // Retained as a permanently-false field: the wake/resync machinery was removed
  // (terminals stay fully live in the background), so nothing arms this anymore.
  // The reveal guard (wakeForFocus) and the reconciliation watchdog still read
  // it; kept false to avoid churning that read surface.
  needsWake?: boolean;

  // First-paint perf instrumentation (#9809). terminalOpenStartedAt is stamped
  // (performance.now()) just before terminal.open() in attach(); the first real
  // write reads it to emit TERMINAL_FIRST_WRITE with an open→first-byte delta.
  // hasEmittedFirstWriteMark gates that mark to once per terminal.
  terminalOpenStartedAt?: number;
  hasEmittedFirstWriteMark?: boolean;

  // One-shot flag (#9702): a fullWakeForVisibilityRestore was requested while
  // this terminal was mid-attach (isAttaching) and skipped to avoid racing the
  // attach. Consumed by notifyAttachSettledWaiters, which re-runs the wake once
  // attach has settled.
  pendingVisibilityWake?: boolean;

  // Typing burst timer
  inputBurstTimer?: number;

  // PTY write-burst decay state. `writeBurstDeadline` is a timestamp
  // (Date.now() + WRITE_BURST_DECAY_MS) refreshed on every write — used as an
  // O(1) extension instead of churning clearTimeout/setTimeout per write,
  // which would jank Chromium's timer queue under 60fps output floods. The
  // single `writeBurstTimer` self-rearms if the deadline was extended while
  // it was pending; on fire with the deadline elapsed it reverts the tier via
  // managed.getRefreshTier().
  writeBurstTimer?: number;
  writeBurstDeadline?: number;

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
  // Output that arrived mid-restore, replayed once the restore settles. Each
  // entry keeps the ingest batch's chunkCount so the replay write can settle
  // the SAME pending port-ack FIFO entries the batch owns — the entries are
  // deliberately NOT settled at defer time (see TerminalWriteController), so
  // the host's flow control keeps pacing the PTY while the restore runs.
  deferredOutput: Array<{ data: string | Uint8Array; chunkCount: number }>;

  // Background scrollback restore state — prevents double-restore and tracks
  // lifecycle. Restores are queued ("pending"), replay asynchronously
  // ("in-progress"), then settle to "done" (or reset to "none" on bail/failure).
  scrollbackRestoreState: "none" | "pending" | "in-progress" | "done";
  // Out-of-band failure channel set by TerminalRestoreController catch blocks
  // when the deferred restore replay fails (write timeout, parse error). The
  // scheduler reads this after fetchAndRestore() resolves to surface the
  // failure to the panel store. Cleared at the start of each restore attempt
  // and on the success path. See issue #8535.
  lastScrollbackRestoreError?: TerminalScrollbackRestoreError;

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

  ipcListenerCount: number;

  // Visibility-driven WebGL restore debounce. Show path waits ~100ms before
  // re-ensuring the addon, so rapid tab/panel toggles don't repeatedly
  // construct/dispose addons even when the manager-level mode flag is stable.
  webGLRestoreTimer?: number;

  // Visibility-driven WebGL release hysteresis. Hide path holds eligibility
  // for ~500ms before calling releaseContext, so rapid hide→show cycles don't
  // repeatedly drop/re-add the terminal to the manager's `wants` set.
  // Authoritative release paths (tier demotion, agent demotion, destroy,
  // hibernation) cancel this timer and release immediately. Note: while the
  // timer is armed, the terminal still counts toward the mode-switch
  // threshold — see TerminalWebGLManager for the trade-off.
  webGLHideTimer?: number;

  // Timestamp of the most recent successful reduceScrollback() — gates the
  // BACKGROUND-tier scrollback shrink path so rapid tab oscillation doesn't
  // re-allocate the xterm CircularList on every flip. Cleared on tier upgrade
  // in onTierApplied so restoreScrollback always runs and the next BACKGROUND
  // transition is not artificially delayed.
  lastScrollbackReduceAt?: number;
}

export const TIER_DOWNGRADE_HYSTERESIS_MS = 500;

// Idle window after the last PTY write before the BURST tier decays back to
// the panel's natural tier (FOCUSED/VISIBLE/...). Independent of
// TIER_DOWNGRADE_HYSTERESIS_MS — that is the policy's downgrade debounce
// inside TerminalRendererPolicy; this is the activity-window inside
// TerminalInstanceService. They are separately tunable even though they
// happen to share the same default value.
export const WRITE_BURST_DECAY_MS = 500;

// Cooldown between consecutive reduceScrollback() calls for the same terminal.
// Each call mutates `terminal.options.scrollback`, which xterm 6.0 turns into
// a BufferSet.setup() that recreates the internal CircularList — cheap once,
// but rapid repetition under tab oscillation produces GC pressure. 2000ms
// covers the typical ~1s flip cadence with margin. The 500ms tier-downgrade
// hysteresis is additive, not a replacement.
export const SCROLLBACK_REDUCE_COOLDOWN_MS = 2000;

// Recency window for classifying a terminal as "in an active write burst" in
// the WebGL pool eviction scorer. A terminal whose lastWriteAt is within this
// window is protected from eviction even after pendingWrites drains to 0, so a
// streaming agent doesn't lose its slot in the gap between output chunks.
// Mirrors SCROLLBACK_REDUCE_COOLDOWN_MS — same 2s burst-cadence assumption.
export const WRITE_BURST_RECENCY_MS = 2000;

export const INCREMENTAL_RESTORE_CONFIG = {
  chunkBytes: 32768,
  timeBudgetMs: 10,
  indicatorThresholdBytes: 262144,
} as const;

// Trailing-edge window for `scheduleBatchResize`. A burst of grid open/close
// resizes within this gap collapses into one pass — long enough to coalesce a
// rapid close stream, short enough that survivors settle promptly after it.
// Lives here (not in TerminalInstanceService) so the paint-fabric compositor
// can coalesce its cross-surface pass on identical timing without importing
// the service module it is imported by.
export const GRID_RESIZE_COALESCE_MS = 120;

/**
 * Tiers eligible for a live WebGL context: the user is actively looking at
 * the terminal (FOCUSED), it just received a typing burst (BURST), or it is
 * visible in a non-focused split (VISIBLE). BACKGROUND/HIDDEN tiers release
 * the WebGL context to free a pool slot. Centralised so the four call sites
 * (renderer policy `onTierApplied`, visibility-driven restore, attach open
 * path, agent promotion) stay in lockstep.
 *
 * VISIBLE is included because xterm's pixel-perfect block / box-drawing /
 * Powerline glyph rendering only works under the WebGL or canvas renderer —
 * the DOM renderer always falls back to the configured font, which
 * mangles glyphs like U+2584 used in agent ASCII-art headers. Limiting WebGL
 * to FOCUSED|BURST visibly degraded rendering on every unfocused-but-visible
 * agent pane in tiled fleets.
 */
export function isWebGLEligibleTier(tier: TerminalRefreshTier | undefined): boolean {
  return (
    tier === TerminalRefreshTier.FOCUSED ||
    tier === TerminalRefreshTier.BURST ||
    tier === TerminalRefreshTier.VISIBLE
  );
}

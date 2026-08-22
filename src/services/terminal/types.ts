import { Terminal, IDisposable, IMarker, ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { ImageAddon } from "@xterm/addon-image";
import type { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { TerminalRefreshTier, PanelKind, AgentState } from "@/types";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";
import type { TerminalGeometry } from "@shared/types/terminal";
import type { TerminalResizeResult } from "@shared/types/pty-host";

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
  kind: "file" | "directory" | "url";
  /** Resolved absolute path — present for `kind === "file"` and `"directory"`. */
  absolutePath?: string;
}

export type AgentStateCallback = (state: AgentState) => void;

export type PostCompleteHook = (output: string) => void | Promise<void>;

/**
 * Intent marker for a renderer/geometry resync (#11638). `force` means the user
 * explicitly asked for this repair — the Redraw action or its bulk per-worktree
 * variant — and it bypasses EXACTLY ONE guard: #10863's write-quiescence
 * deferral ({@link https://github.com/daintreehq/daintree/issues/10863}), which
 * exists to stop an AUTOMATIC out-of-band re-wrap from landing under a live
 * cursor-relative repaint. A user staring at a garbled pane has already made
 * that call, and a busy agent never opens the 300ms gap the guard waits for, so
 * without the bypass the one load-bearing step of Redraw is dead on exactly the
 * terminals it exists for.
 *
 * Still enforced under `force`: the alt-screen exclusion (#10805), host
 * visibility, the >=50px box floor, cell-metric availability, the
 * serialized-restore parking, and the pre-resize drain of held ingest bytes.
 *
 * Also note what `force` implies beyond the stream gate: it routes the repair
 * through the lock-exempt atomic reconcile rather than `fit()`, so it can land
 * during a resize lock (a divider drag, DnD, the project-switch suppression
 * window). That is deliberate — the lock is how the pane got stale in the
 * first place, and deferring to the end-of-transition pass is the same
 * hand-off-to-something-that-never-runs that made Redraw a no-op.
 *
 * Deliberately absent from `TerminalRevealController` and the watchdog's dep
 * signatures so no automatic path can even ask for it. The two actions that do
 * ask gate it on `isForegroundDispatch` — an agent or plugin driving Redraw on
 * a timer IS the automatic writer #10863 was written for.
 */
export interface TerminalResyncOptions {
  force?: boolean;
}

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
  searchAddon: SearchAddon | null;
  searchAddonPromise?: Promise<SearchAddon | null>;
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
  // Last time TerminalReflowController issued a renderer-unpause repair for this
  // terminal — throttles the repair across write/heartbeat/focus triggers.
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
  // Circuit breaker for the watchdog's renderer-unpause repair (#11800). xterm's
  // `_isPaused` is written only by its own IntersectionObserver callback, so the
  // repair has to force the flag and repaint; if something re-pauses the pane
  // every sweep, these bound the retry instead of forcing a repaint forever.
  rendererUnpauseAttempts?: number;
  // Once tripped, the paused-renderer branch stops issuing repairs — the WebGL
  // layer below it still reconciles. Cleared when a later sweep observes the
  // renderer unpaused, or when the terminal re-attaches.
  rendererUnpauseGaveUp?: boolean;
  // The attachGeneration the counter accrued under — mirrors geometryRepairGeneration.
  rendererUnpauseGeneration?: number;
  // When the last unpause repair was issued. Recovery is only believable once
  // real frames have had a chance since then: the reflow controller and the
  // watchdog both listen for visibilitychange/reveal and run in the SAME event
  // turn, so without this the watchdog would read its sibling's just-written
  // `false` as durable recovery and re-arm the breaker on a renderer that
  // nothing has actually fixed.
  rendererUnpauseAttemptedAt?: number;
  // Geometry the PTY reported holding after its last resize (#11641). The only
  // view the renderer has of the backend grid — everything else here describes
  // xterm's side.
  lastPtyResizeResult?: TerminalResizeResult;
  // Divergence episodes seen between the applied PTY grid and xterm's grid.
  // Counts episodes, not watchdog ticks: it advances only when the divergence
  // signature changes, so it stays in step with what was logged.
  ptyGeometryDivergenceCount?: number;
  // The PTY launchGeneration the count accrued under. Scoped to the PTY
  // incarnation, NOT attachGeneration — detaching and reattaching a pane leaves
  // the same PTY running, so its divergence history is still the pane's own.
  ptyGeometryDivergenceGeneration?: number;
  // Signature of the divergence currently being reported, so a persistently
  // split pane logs once per episode instead of once per sweep. Cleared only on
  // observed agreement.
  ptyGeometryDivergenceSignature?: string;
  // Same episode-dedup for the container-vs-xterm fit diagnostic.
  fitGeometryDivergenceSignature?: string;
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
  /**
   * The grid this pane belongs on once the in-flight serialized restore
   * finishes (#11552).
   *
   * A snapshot only decodes at the width it was captured on, so a restore
   * temporarily resizes xterm to the capture grid before writing. That makes
   * `terminal.cols` a lie for the duration: an external resize applied against
   * it would be reflowed away by the normalization that follows, and a
   * successor restore reading it would adopt the capture width as "live".
   * Seeded from the real grid when the outermost restore opens the window,
   * overwritten by any resize that lands mid-replay
   * (`TerminalResizeController.resizeTerminal` parks instead of applying), and
   * drained by the restore that normalizes back. Undefined outside a restore.
   *
   * "The real grid" is `terminal.cols/rows` only for an OPENED pane. A pane that
   * has never been opened was never measured, so it still sits at whatever it
   * was constructed at; `TerminalRestoreController.intendedGeometry` seeds those
   * from the attach target or the snapshot's capture grid instead, so a restore
   * cannot strand a live background pane on a constructor default (#11718).
   */
  pendingRestoreGeometry?: TerminalGeometry;
  /**
   * Monotonic id for the currently-open serialized-restore window (#11552).
   *
   * Deliberately separate from `restoreGeneration`: that one CANCELS an
   * in-flight replay, so reusing it to identify a window would mean a snapshot
   * fetch had to abort whatever was replaying just to be able to tell whether
   * the window was still its own to close — and if the fetch then came back
   * null, it would release output over a half-replayed buffer. This only
   * answers "am I still the owner", never "should you stop".
   */
  restoreWindowToken: number;
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

  // Count of PTY-bound entries at the head of `listeners`, recorded before
  // installTerminalBoundListeners appends the xterm-bound ones. The split
  // point matters for the #11776 rebuild: the tail belongs to the disposed
  // Terminal and must be re-installed, the head belongs to the PTY and must
  // survive.
  ipcListenerCount: number;

  // Attach failure state (#11776). Deliberately NOT folded into `isOpened`:
  // that flag answers "has open() been completed", and overloading it with
  // "did open() succeed" is what let a permanently-unpaintable terminal look
  // healthy to every retry path. Message only — the Error itself would pin the
  // whole poisoned instance graph via its stack.
  lastAttachError?: string;
  // Consecutive automatic rebuild attempts. Bounds recovery so a terminal that
  // cannot be rebuilt (a host that is genuinely never renderable) degrades to a
  // banner rather than looping.
  attachRecoveryAttempts?: number;
  // In-flight rebuild, so concurrent triggers (attach, reveal, watchdog, the
  // banner's Retry) share one rebuild instead of racing several.
  attachRecoveryInFlight?: Promise<boolean>;
  // The custom key handler XtermAdapter installed on the current Terminal.
  // Recorded so a rebuild can re-attach it: `keyHandlerInstalled` would
  // otherwise stay true against a fresh Terminal that has no handler, leaving
  // the rebuilt pane unable to accept keyboard input.
  customKeyEventHandler?: (event: KeyboardEvent) => boolean;

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
 * mangles glyphs like U+2584 (agent ASCII-art headers, TUI box-drawing).
 * Limiting WebGL to FOCUSED|BURST visibly degraded rendering on every
 * unfocused-but-visible pane in tiled fleets — for standard terminals as much
 * as agents (#11193), which is why eligibility is identity-neutral.
 */
export function isWebGLEligibleTier(tier: TerminalRefreshTier | undefined): boolean {
  return (
    tier === TerminalRefreshTier.FOCUSED ||
    tier === TerminalRefreshTier.BURST ||
    tier === TerminalRefreshTier.VISIBLE
  );
}

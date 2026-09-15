// Keeps a scrolled-back reader in place when the program on the PTY wipes the
// scrollback (ESC[3J) and redraws it — Codex rebuilds its whole transcript
// that way after any height change, and on stream finish if a resize landed
// mid-stream (#12398).
//
// xterm's ED3 handler trims every scrollback line and zeroes ybase/ydisp but
// leaves BufferService.isUserScrolling set, so as the transcript is
// re-inserted a bottom-following buffer follows it down while a scrolled-back
// one stays parked on line 0 — the startup banner. The internal scroll event
// ED3 fires never reaches the public `onScroll`, so nothing app-side notices.
//
// This observes the erase on the parser (our handler runs before xterm's, so
// the buffer is still intact), remembers where the reader was, and scrolls
// back to the same content once the redraw's synchronized-output block closes
// and the browser viewport has re-synced to the rebuilt buffer. Agent-agnostic:
// only the byte sequence and the buffer position decide anything.

type CsiParams = (number | number[])[];

/**
 * The slice of `Terminal` this needs — structural so `@xterm/headless` (the
 * same core, no renderer) can drive it in tests.
 */
export interface ViewportAnchorTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type: "normal" | "alternate";
      readonly viewportY: number;
      readonly baseY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  readonly modes: { readonly synchronizedOutputMode: boolean };
  readonly parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: CsiParams) => boolean
    ): { dispose(): void };
  };
  onScroll(listener: (position: number) => void): { dispose(): void };
  onWriteParsed(listener: () => void): { dispose(): void };
  scrollToLine(line: number): void;
}

export interface ViewportAnchorDeps {
  /**
   * True while a Daintree-owned clear is queued or parsing — a serialized
   * scrollback restore, or a worker-mirror snapshot apply (`mirrorApply.ts`
   * writes ESC[3J of its own). Those manage their own position.
   */
  isOwnClear(): boolean;
  /**
   * Run `callback` once after the renderer has painted and the viewport has
   * synced to the buffer. Returns a cancel. In the browser this is the next
   * `onRender`; headless has no renderer, so tests drive it by hand.
   */
  afterRender(callback: () => void): () => void;
  /** Re-sync the DOM viewport to the buffer after a programmatic scroll (the #11709 seam). */
  syncViewport(): void;
  getUnseen(): number;
  restoreUnseen(count: number): void;
}

export type ViewportAnchorPhase = "idle" | "armed" | "restoring";

export interface ViewportAnchorController {
  /** The reader took over (wheel, scroll keys): drop any pending restore. */
  cancel(): void;
  dispose(): void;
  readonly phase: ViewportAnchorPhase;
}

/** Top visible lines captured as the content anchor. */
export const ANCHOR_LINE_COUNT = 3;
/** Quiet time after the last parsed write that ends a redraw with no sync block (a plain `clear`). */
export const REPLAY_QUIET_MS = 150;
/** Hard bound from the erase to the restore attempt, so a streaming program cannot hold it open. */
export const REPLAY_DEADLINE_MS = 2000;
/** Bound on waiting for a render (a hidden pane never paints); the attempt runs anyway when it lapses. */
export const RENDER_WAIT_MS = 1000;
/** How far from the distance-based guess the anchor search looks, in lines each way. */
export const ANCHOR_SEARCH_RADIUS = 2000;
const MAX_RESTORE_ATTEMPTS = 2;
const SYNCHRONIZED_OUTPUT_MODE = 2026;

interface PendingAnchor {
  phase: "armed" | "restoring";
  distanceFromBottom: number;
  cols: number;
  lines: string[];
  unseen: number;
  /** Where the buffer should sit unless the reader moves it; anything else is a cancel. */
  expectedViewportY: number;
  target?: number;
  attempts: number;
  quietTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  renderWaitTimer?: ReturnType<typeof setTimeout>;
  cancelRender?: () => void;
}

function firstParam(params: CsiParams): number {
  const first = params[0];
  if (first === undefined) return 0;
  return Array.isArray(first) ? (first[0] ?? 0) : first;
}

function hasParam(params: CsiParams, value: number): boolean {
  return params.some((p) => (Array.isArray(p) ? p.includes(value) : p === value));
}

export function installViewportAnchorController(
  terminal: ViewportAnchorTerminal,
  deps: ViewportAnchorDeps
): ViewportAnchorController {
  let pending: PendingAnchor | undefined;
  let selfScrolling = false;

  const clearTimers = (p: PendingAnchor): void => {
    if (p.quietTimer !== undefined) clearTimeout(p.quietTimer);
    if (p.deadlineTimer !== undefined) clearTimeout(p.deadlineTimer);
    if (p.renderWaitTimer !== undefined) clearTimeout(p.renderWaitTimer);
    p.quietTimer = p.deadlineTimer = p.renderWaitTimer = undefined;
  };

  const release = (): void => {
    if (!pending) return;
    clearTimers(pending);
    pending.cancelRender?.();
    pending = undefined;
  };

  const captureAnchorLines = (): string[] => {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < ANCHOR_LINE_COUNT; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      if (!line) break;
      lines.push(line.translateToString(true));
    }
    // An all-blank anchor matches everywhere; the distance fallback is better.
    return lines.some((text) => text.length > 0) ? lines : [];
  };

  const restartQuietTimer = (): void => {
    if (!pending || pending.phase !== "armed") return;
    if (pending.quietTimer !== undefined) clearTimeout(pending.quietTimer);
    pending.quietTimer = setTimeout(onQuiet, REPLAY_QUIET_MS);
  };

  const arm = (): void => {
    const buffer = terminal.buffer.active;
    pending = {
      phase: "armed",
      distanceFromBottom: buffer.baseY - buffer.viewportY,
      cols: terminal.cols,
      lines: captureAnchorLines(),
      unseen: deps.getUnseen(),
      // ED3 leaves ydisp at 0 and buffer-driven scrolling keeps it there while
      // the reader is scrolled back; a different value means the reader moved.
      expectedViewportY: 0,
      attempts: 0,
    };
    pending.deadlineTimer = setTimeout(onDeadline, REPLAY_DEADLINE_MS);
    restartQuietTimer();
  };

  const onQuiet = (): void => {
    if (!pending || pending.phase !== "armed") return;
    pending.quietTimer = undefined;
    // Inside a sync block the DECRST handler is the precise end; the deadline
    // covers a block that never closes.
    if (terminal.modes.synchronizedOutputMode) return;
    beginRestore();
  };

  const onDeadline = (): void => {
    if (!pending) return;
    pending.deadlineTimer = undefined;
    if (pending.phase === "armed") beginRestore();
  };

  const waitForRender = (callback: () => void): void => {
    if (!pending) return;
    const p = pending;
    const run = (): void => {
      if (pending !== p) return;
      if (p.renderWaitTimer !== undefined) clearTimeout(p.renderWaitTimer);
      p.renderWaitTimer = undefined;
      p.cancelRender?.();
      p.cancelRender = undefined;
      callback();
    };
    p.cancelRender = deps.afterRender(run);
    p.renderWaitTimer = setTimeout(run, RENDER_WAIT_MS);
  };

  const beginRestore = (): void => {
    if (!pending || pending.phase !== "armed") return;
    pending.phase = "restoring";
    clearTimers(pending);
    // The redraw re-inserted content the reader already had. Counts are write
    // batches incremented on enqueue, so at most the batch carrying the erase
    // itself stays counted — within the pill's threshold tolerance.
    deps.restoreUnseen(pending.unseen);
    waitForRender(attemptRestore);
  };

  const resolveTarget = (p: PendingAnchor): number => {
    const buffer = terminal.buffer.active;
    const fallback = Math.max(0, Math.min(buffer.baseY, buffer.baseY - p.distanceFromBottom));
    // A width change re-wraps every line; the text anchor no longer describes rows.
    if (p.lines.length === 0 || terminal.cols !== p.cols) return fallback;

    // The anchor may now sit on the final screen (a capped replay); a start
    // past baseY is still a hit and clamps to the bottom below.
    const lastStart = buffer.baseY + terminal.rows - 1;
    const matchesAt = (start: number): boolean => {
      for (let i = 0; i < p.lines.length; i++) {
        const line = buffer.getLine(start + i);
        if (!line || line.translateToString(true) !== p.lines[i]) return false;
      }
      return true;
    };
    // Nearest-first around the distance guess: repeated prompts and rules
    // collide, and the closest occurrence is the one the reader was on.
    for (let delta = 0; delta <= ANCHOR_SEARCH_RADIUS; delta++) {
      const below = fallback + delta;
      if (below <= lastStart && matchesAt(below)) return below;
      if (delta === 0) continue;
      const above = fallback - delta;
      if (above >= 0 && matchesAt(above)) return above;
    }
    return fallback;
  };

  const attemptRestore = (): void => {
    if (!pending || pending.phase !== "restoring") return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal" || deps.isOwnClear()) {
      release();
      return;
    }
    if (pending.target === undefined) pending.target = resolveTarget(pending);
    const target = Math.min(pending.target, buffer.baseY);
    // Also the verification leg: a scroll that took ends here.
    if (buffer.viewportY === target || pending.attempts >= MAX_RESTORE_ATTEMPTS) {
      release();
      return;
    }
    pending.attempts += 1;
    pending.expectedViewportY = target;
    // The browser build scrolls through the DOM viewport, and inside a sync
    // block the viewport defers its sync to the next render — so this runs
    // after one, and the read-back on the following frame retries once if
    // the scroll landed on stale dimensions.
    selfScrolling = true;
    try {
      terminal.scrollToLine(target);
    } finally {
      selfScrolling = false;
    }
    deps.syncViewport();
    waitForRender(attemptRestore);
  };

  const disposables = [
    // Runs before xterm's own ED handler (newest first); `false` lets the erase proceed.
    terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (firstParam(params) !== 3 || pending) return false;
      const buffer = terminal.buffer.active;
      if (buffer.type === "normal" && buffer.viewportY < buffer.baseY && !deps.isOwnClear()) {
        arm();
      }
      return false;
    }),
    // DECRST 2026 closes the redraw's sync block. With nothing in scrollback
    // yet it is the tail of the frame the erase interrupted, not the redraw's
    // end — restoring now would be a no-op, so keep waiting for the real one.
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (
        pending?.phase === "armed" &&
        hasParam(params, SYNCHRONIZED_OUTPUT_MODE) &&
        terminal.buffer.active.baseY > 0
      ) {
        beginRestore();
      }
      return false;
    }),
    terminal.onWriteParsed(restartQuietTimer),
    // Buffer-driven scrolls during the redraw report the unchanged ydisp; a
    // scrollbar drag, scroll key, or scroll-to-bottom reports a new one.
    terminal.onScroll(() => {
      if (!pending || selfScrolling) return;
      if (terminal.buffer.active.viewportY !== pending.expectedViewportY) release();
    }),
  ];

  return {
    cancel: release,
    dispose: () => {
      release();
      for (const disposable of disposables) disposable.dispose();
    },
    get phase(): ViewportAnchorPhase {
      return pending?.phase ?? "idle";
    },
  };
}

/**
 * TerminalFrameStabilizer - SYNCHRONIZED OUTPUT MODE AWARE
 *
 * Respects the synchronized output protocol (DEC private mode 2026):
 * - When we see \x1b[?2026h (start sync), buffer all output
 * - When we see \x1b[?2026l (end sync), emit the complete frame
 * - This prevents showing half-drawn frames during TUI redraws
 *
 * For data outside sync mode, uses stability detection:
 * - No new data for STABILITY_MS (100ms) = frame complete
 * - MAX_HOLD_MS (200ms) = safety valve for continuous streams
 *
 * Claude Code and similar TUIs use sync mode for atomic screen updates.
 */

import type { Terminal as HeadlessTerminal } from "@xterm/headless";

// Synchronized output mode (DEC private mode 2026)
// When enabled, terminal should buffer all output until disabled
const SYNC_OUTPUT_START = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";

// Traditional frame boundaries (for TUIs that don't use sync mode)
const CLEAR_SCREEN = "\x1b[2J";
const ALT_BUFFER_ON = "\x1b[?1049h";

// How long to wait before assuming current frame is complete
const STABILITY_MS = 100;

// Interactive mode - shorter stability window
const INTERACTIVE_STABILITY_MS = 32;

// How long interactive mode lasts
const INTERACTIVE_WINDOW_MS = 1000;

// Maximum time to hold a frame before force emitting (5 FPS minimum)
const MAX_HOLD_MS = 200;

// Max buffer before force flush
const MAX_BUFFER_SIZE = 512 * 1024;

export interface FrameStabilizerOptions {
  verbose?: boolean;
}

export class TerminalFrameStabilizer {
  private emitCallback: ((data: string) => void) | null = null;

  // Current frame being built
  private buffer = "";

  // Synchronized output mode - don't emit while active
  private inSyncMode = false;

  // Stability timer
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;

  // Max hold timer
  private maxHoldTimer: ReturnType<typeof setTimeout> | null = null;

  // Sync mode timeout - if we never get the end sequence, force emit
  private syncTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Interactive mode
  private interactiveUntil = 0;

  // Stats
  private framesEmitted = 0;

  // Debug
  private verbose: boolean;

  constructor(options?: FrameStabilizerOptions) {
    this.verbose = options?.verbose ?? process.env.CANOPY_VERBOSE === "1";
  }

  attach(_headless: HeadlessTerminal, emit: (data: string) => void): void {
    this.emitCallback = emit;
  }

  detach(): void {
    this.cancelStabilityTimer();
    this.cancelMaxHoldTimer();
    this.cancelSyncTimeoutTimer();
    this.inSyncMode = false;
    // Emit any pending data
    if (this.buffer) {
      this.emit(this.buffer, "detach");
      this.buffer = "";
    }
    this.emitCallback = null;
  }

  markInteractive(ttlMs: number = INTERACTIVE_WINDOW_MS): void {
    this.interactiveUntil = Date.now() + ttlMs;
  }

  ingest(data: string): void {
    // Append all data to buffer first
    this.buffer += data;

    // Check for synchronized output mode transitions
    this.processSyncMode();

    // Force flush if buffer too large
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.cancelAllTimers();
      this.inSyncMode = false;
      this.emit(this.buffer, "overflow");
      this.buffer = "";
      return;
    }

    // In sync mode - just wait for sync end (with timeout backup)
    if (this.inSyncMode) {
      // Schedule sync timeout if not already scheduled
      if (!this.syncTimeoutTimer) {
        this.scheduleSyncTimeout();
      }
      return;
    }

    // Not in sync mode - check for traditional frame boundaries
    // This handles TUIs that don't use synchronized output (Gemini, Codex, etc.)
    this.processFrameBoundaries();

    // Schedule timers for remaining buffered content
    if (this.buffer.length > 0) {
      if (!this.maxHoldTimer) {
        this.scheduleMaxHoldFlush();
      }
      this.scheduleStabilityFlush();
    }
  }

  /**
   * Process the buffer for sync mode start/end sequences.
   * Emits complete frames when sync mode ends.
   */
  private processSyncMode(): void {
    // Look for sync START in buffer
    const syncStartIdx = this.buffer.indexOf(SYNC_OUTPUT_START);
    if (syncStartIdx !== -1 && !this.inSyncMode) {
      // Emit anything before the sync start
      if (syncStartIdx > 0) {
        const beforeSync = this.buffer.substring(0, syncStartIdx);
        this.buffer = this.buffer.substring(syncStartIdx);
        this.cancelAllTimers();
        this.emit(beforeSync, "pre-sync");
      }

      // Enter sync mode
      this.inSyncMode = true;
    }

    // Look for sync END in buffer (only if in sync mode)
    if (this.inSyncMode) {
      const syncEndIdx = this.buffer.indexOf(SYNC_OUTPUT_END);
      if (syncEndIdx !== -1) {
        // Found end - emit everything including the end sequence
        const endOfSequence = syncEndIdx + SYNC_OUTPUT_END.length;
        const completeFrame = this.buffer.substring(0, endOfSequence);
        this.buffer = this.buffer.substring(endOfSequence);

        // Exit sync mode and emit
        this.inSyncMode = false;
        this.cancelAllTimers();
        this.emit(completeFrame, "sync-complete");

        // Process any remaining data (might have more sync sequences)
        if (this.buffer.length > 0) {
          this.processSyncMode();
        }
      }
    }
  }

  /**
   * Process traditional frame boundaries (clear screen, alt buffer).
   * Used for TUIs that don't support synchronized output mode.
   */
  private processFrameBoundaries(): void {
    // Find earliest frame boundary
    let clearIdx = this.buffer.indexOf(CLEAR_SCREEN);
    let altIdx = this.buffer.indexOf(ALT_BUFFER_ON);

    // If boundary is at position 0, look for the NEXT boundary
    // (the one at 0 is the start of a frame, we want to find where that frame ends)
    if (clearIdx === 0) {
      const nextClear = this.buffer.indexOf(CLEAR_SCREEN, CLEAR_SCREEN.length);
      clearIdx = nextClear;
    }
    if (altIdx === 0) {
      const nextAlt = this.buffer.indexOf(ALT_BUFFER_ON, ALT_BUFFER_ON.length);
      altIdx = nextAlt;
    }

    // Pick earliest boundary
    let boundaryIdx = -1;
    if (clearIdx > 0 && (altIdx === -1 || clearIdx < altIdx)) {
      boundaryIdx = clearIdx;
    } else if (altIdx > 0) {
      boundaryIdx = altIdx;
    }

    if (boundaryIdx === -1) {
      return; // No boundaries found
    }

    // Emit content before boundary
    const beforeBoundary = this.buffer.substring(0, boundaryIdx);
    this.buffer = this.buffer.substring(boundaryIdx);
    this.cancelAllTimers();
    this.emit(beforeBoundary, "frame-boundary");

    // Recurse to handle more boundaries
    this.processFrameBoundaries();
  }

  private scheduleStabilityFlush(): void {
    this.cancelStabilityTimer();

    const delay = this.isInteractive() ? INTERACTIVE_STABILITY_MS : STABILITY_MS;

    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.cancelMaxHoldTimer();
      if (this.buffer.length > 0) {
        this.emit(this.buffer, "stable");
        this.buffer = "";
      }
    }, delay);
  }

  private cancelStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private scheduleMaxHoldFlush(): void {
    this.cancelMaxHoldTimer();

    this.maxHoldTimer = setTimeout(() => {
      this.maxHoldTimer = null;
      if (this.buffer.length > 0) {
        this.cancelStabilityTimer();
        this.emit(this.buffer, "max-hold");
        this.buffer = "";
      }
    }, MAX_HOLD_MS);
  }

  private cancelMaxHoldTimer(): void {
    if (this.maxHoldTimer) {
      clearTimeout(this.maxHoldTimer);
      this.maxHoldTimer = null;
    }
  }

  private scheduleSyncTimeout(): void {
    this.cancelSyncTimeoutTimer();

    // Give sync mode 500ms before force emitting
    // This is a safety valve in case we never get the end sequence
    this.syncTimeoutTimer = setTimeout(() => {
      this.syncTimeoutTimer = null;
      if (this.inSyncMode && this.buffer.length > 0) {
        this.inSyncMode = false;
        this.emit(this.buffer, "sync-timeout");
        this.buffer = "";
      }
    }, 500);
  }

  private cancelSyncTimeoutTimer(): void {
    if (this.syncTimeoutTimer) {
      clearTimeout(this.syncTimeoutTimer);
      this.syncTimeoutTimer = null;
    }
  }

  private cancelAllTimers(): void {
    this.cancelStabilityTimer();
    this.cancelMaxHoldTimer();
    this.cancelSyncTimeoutTimer();
  }

  private emit(data: string, reason: string): void {
    if (!data || !this.emitCallback) return;

    if (this.verbose) {
      console.log(
        `[FrameStabilizer] Emit #${this.framesEmitted + 1}: ${data.length} bytes (${reason})`
      );
    }

    this.emitCallback(data);
    this.framesEmitted++;
  }

  private isInteractive(): boolean {
    return Date.now() < this.interactiveUntil;
  }

  getDebugState(): {
    hasPending: boolean;
    pendingBytes: number;
    framesEmitted: number;
    isInteractive: boolean;
  } {
    return {
      hasPending: this.buffer.length > 0,
      pendingBytes: this.buffer.length,
      framesEmitted: this.framesEmitted,
      isInteractive: this.isInteractive(),
    };
  }
}

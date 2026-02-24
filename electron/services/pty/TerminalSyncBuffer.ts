/**
 * TerminalSyncBuffer - Legacy Frame Detection for Agent Terminals
 *
 * Buffers PTY output and detects frame boundaries for AI terminal agents
 * (Claude Code, Gemini CLI, Codex, etc.) that don't use DEC 2026 protocol.
 *
 * WHY THIS EXISTS:
 * xterm.js 6.0.0+ handles DEC 2026 (Synchronized Output) natively, but some
 * TUIs don't use this protocol. This buffer detects traditional frame
 * boundaries to reduce flicker for those applications.
 *
 * HOW IT WORKS:
 * - Detects traditional frame boundaries (clear screen \x1b[2J, alt buffer)
 * - Stability timeout (100ms quiet = frame complete)
 * - Safety valve: 200ms max hold before force flush
 *
 * WHAT IT DOESN'T DO:
 * - DEC 2026 protocol handling (xterm.js 6.0.0+ handles this natively)
 * - BSU/ESU sequences pass through unchanged to xterm.js
 *
 * SCOPE:
 * Only enabled for agent terminals (isAgentTerminal). Normal shells bypass
 * this entirely for zero-latency pass-through.
 */

import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

// Traditional frame boundaries (for TUIs that don't use DEC 2026)
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

export interface SyncBufferOptions {
  verbose?: boolean;
  terminalId?: string;
}

export class TerminalSyncBuffer {
  private emitCallback: ((data: string) => void) | null = null;

  // Current frame being built
  private buffer = "";

  // Stability timer
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;

  // Max hold timer
  private maxHoldTimer: ReturnType<typeof setTimeout> | null = null;

  // Bypass mode - passthrough when in alt screen buffer
  private bypassed = false;

  // Interactive mode
  private interactiveUntil = 0;

  // Stats
  private framesEmitted = 0;

  // Debug
  private verbose: boolean;
  private terminalId: string;
  private debugFrames: boolean;

  constructor(options?: SyncBufferOptions) {
    this.verbose = options?.verbose ?? process.env.CANOPY_VERBOSE === "1";
    this.terminalId = options?.terminalId ?? "unknown";
    this.debugFrames = process.env.CANOPY_DEBUG_FRAMES === "1";
  }

  private debugLog(event: string, data: string): void {
    if (!this.debugFrames) return;

    const logDir = process.env.CANOPY_USER_DATA
      ? join(process.env.CANOPY_USER_DATA, "debug")
      : "/tmp/canopy-debug";

    try {
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, "frame-sequences.log");
      const timestamp = new Date().toISOString();
      // eslint-disable-next-line no-control-regex
      const escapeRe = /\x1b/g;
      const escaped = data.replace(escapeRe, "\\x1b").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      appendFileSync(logFile, `[${timestamp}] [${this.terminalId}] ${event}: ${escaped}\n`);
    } catch {
      // Ignore logging errors
    }
  }

  attach(_headless: HeadlessTerminal, emit: (data: string) => void): void {
    this.emitCallback = emit;
  }

  detach(): void {
    this.cancelStabilityTimer();
    this.cancelMaxHoldTimer();
    // Emit any pending data
    if (this.buffer) {
      this.emit(this.buffer, "detach");
      this.buffer = "";
    }
    this.emitCallback = null;
  }

  setBypass(bypass: boolean): void {
    if (this.bypassed === bypass) return;
    this.bypassed = bypass;
    if (bypass && this.buffer.length > 0) {
      this.cancelAllTimers();
      this.emit(this.buffer, "bypass-flush");
      this.buffer = "";
    }
  }

  markInteractive(ttlMs: number = INTERACTIVE_WINDOW_MS): void {
    this.interactiveUntil = Date.now() + ttlMs;
  }

  ingest(data: string): void {
    if (this.bypassed) {
      this.emit(data, "bypass");
      return;
    }

    this.debugLog("INGEST", data.slice(0, 500));

    // Append all data to buffer first
    this.buffer += data;

    // Force flush if buffer too large
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.cancelAllTimers();
      this.emit(this.buffer, "overflow");
      this.buffer = "";
      return;
    }

    // Check for traditional frame boundaries
    // This handles TUIs that don't use DEC 2026 (Gemini, Codex, etc.)
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

      if (this.buffer.length > 0) {
        this.cancelMaxHoldTimer();
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

  private cancelAllTimers(): void {
    this.cancelStabilityTimer();
    this.cancelMaxHoldTimer();
  }

  private emit(data: string, reason: string): void {
    if (!data || !this.emitCallback) return;

    this.debugLog(`EMIT(${reason})`, data.slice(0, 200));

    if (this.verbose) {
      console.log(`[SyncBuffer] Emit #${this.framesEmitted + 1}: ${data.length} bytes (${reason})`);
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
    bypassed: boolean;
  } {
    return {
      hasPending: this.buffer.length > 0,
      pendingBytes: this.buffer.length,
      framesEmitted: this.framesEmitted,
      isInteractive: this.isInteractive(),
      bypassed: this.bypassed,
    };
  }
}

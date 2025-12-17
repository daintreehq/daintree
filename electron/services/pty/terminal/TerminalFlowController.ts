/**
 * TerminalFlowController - Handles per-terminal flow control.
 *
 * Extracted from TerminalProcess to separate flow control concerns:
 * - Tracks unacknowledged character count
 * - Manages PTY pause/resume based on watermarks
 * - Supports SAB mode bypass
 */

import type * as pty from "node-pty";

// Flow Control Constants (VS Code values)
const HIGH_WATERMARK_CHARS = 100000;
const LOW_WATERMARK_CHARS = 5000;

export interface FlowControlCallbacks {
  onPause?: () => void;
  onResume?: () => void;
}

export class TerminalFlowController {
  private _unacknowledgedCharCount = 0;
  private _isPtyPaused = false;
  private _sabModeEnabled: boolean;

  constructor(
    private ptyProcess: pty.IPty,
    private isAgentTerminal: boolean,
    sabModeEnabled: boolean = false,
    private callbacks?: FlowControlCallbacks,
    private verbose: boolean = false
  ) {
    this._sabModeEnabled = sabModeEnabled;
  }

  /**
   * Get whether the PTY is currently paused.
   */
  get isPaused(): boolean {
    return this._isPtyPaused;
  }

  /**
   * Get the current unacknowledged character count.
   */
  get unacknowledgedCharCount(): number {
    return this._unacknowledgedCharCount;
  }

  /**
   * Track output data and apply flow control if needed.
   * Should be called for each data chunk received from PTY.
   */
  trackOutput(dataLength: number): void {
    // In SAB mode or for agent terminals, per-terminal flow control is bypassed
    if (this._sabModeEnabled || this.isAgentTerminal) {
      return;
    }

    this._unacknowledgedCharCount += dataLength;

    if (!this._isPtyPaused && this._unacknowledgedCharCount > HIGH_WATERMARK_CHARS) {
      if (this.verbose) {
        console.log(
          `[TerminalFlowController] Pausing PTY (${this._unacknowledgedCharCount} > ${HIGH_WATERMARK_CHARS})`
        );
      }
      try {
        this.ptyProcess.pause();
        this._isPtyPaused = true;
        this.callbacks?.onPause?.();
      } catch {
        // Process might be dead
      }
    }
  }

  /**
   * Acknowledge data processing from frontend.
   * Only has effect in IPC fallback mode.
   */
  acknowledgeData(charCount: number): void {
    // Agent terminals and SAB mode bypass per-terminal acks
    if (this.isAgentTerminal || this._sabModeEnabled) {
      return;
    }

    this._unacknowledgedCharCount = Math.max(0, this._unacknowledgedCharCount - charCount);

    if (this._isPtyPaused && this._unacknowledgedCharCount < LOW_WATERMARK_CHARS) {
      if (this.verbose) {
        console.log(
          `[TerminalFlowController] Resuming PTY (${this._unacknowledgedCharCount} < ${LOW_WATERMARK_CHARS})`
        );
      }
      try {
        this.ptyProcess.resume();
        this._isPtyPaused = false;
        this.callbacks?.onResume?.();
      } catch {
        // Process might be dead
      }
    }
  }

  /**
   * Update SAB mode setting dynamically.
   * If enabling SAB mode while terminal is paused, immediately resume.
   */
  setSabModeEnabled(enabled: boolean): void {
    this._sabModeEnabled = enabled;
    if (enabled) {
      this._unacknowledgedCharCount = 0;
      if (this._isPtyPaused) {
        try {
          this.ptyProcess.resume();
          this._isPtyPaused = false;
          this.callbacks?.onResume?.();
        } catch {
          // Ignore resume errors
        }
      }
    }
  }

  /**
   * Update the PTY process reference.
   */
  updatePtyProcess(ptyProcess: pty.IPty): void {
    this.ptyProcess = ptyProcess;
  }
}

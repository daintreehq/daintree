import type { TerminalInfo } from "./types.js";
import type { AnalysisBackend } from "./analysis/AnalysisBackend.js";
import { IdentityWatcher, normalizeShellCommandText } from "./IdentityWatcher.js";
import { WriteQueue } from "./WriteQueue.js";
import { logIdentityDebug } from "./identityDebug.js";
import {
  normalizeSubmitText,
  splitTrailingNewlines,
  supportsBracketedPaste,
  getSoftNewlineSequence,
  getSubmitEnterDelay,
  isBracketedPaste,
  isFocusReport,
  delay,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  PASTE_THRESHOLD_CHARS,
  OUTPUT_SETTLE_DEBOUNCE_MS,
  OUTPUT_SETTLE_MAX_WAIT_MS,
  OUTPUT_SETTLE_POLL_INTERVAL_MS,
} from "./terminalInput.js";

export interface TerminalInputControllerHost {
  readonly id: string;
  readonly terminalInfo: TerminalInfo;
  readonly analysis: AnalysisBackend;
  readonly identityWatcher: IdentityWatcher;
  readonly writeQueue: WriteQueue;
  logWriteError(error: unknown, context: { operation: string; traceId?: string }): void;
}

export class TerminalInputController {
  private shutdownLockDepth = 0;
  private inputGeneration = 0;

  constructor(private readonly host: TerminalInputControllerHost) {}

  /** True while a graceful shutdown owns the PTY's input stream. */
  get isInputLocked(): boolean {
    return this.shutdownLockDepth > 0;
  }

  /**
   * Take exclusive ownership of this terminal's input for the duration of a
   * graceful shutdown, and return the release (#11851).
   *
   * Teardown writes bypass this controller entirely and go straight to
   * `ptyProcess.write()`. A single quit write mostly got away with that, but a
   * gated Ctrl-C escalation spans a second or more, and anything landing
   * between two presses — a live keystroke on the ≤512-byte fast path, a
   * chunked paste still pacing, the trailing Enter of an in-flight submit —
   * either lands in the agent's composer or breaks the press economics the
   * gate depends on.
   *
   * Blocked input is DROPPED, not buffered. Replaying it after teardown would
   * deliver it to whatever occupies the pane next — a plain shell, or nothing
   * at all — which is worse than losing a keystroke aimed at a process that is
   * being killed.
   *
   * Bumping the generation is what stops work already past its entry guard:
   * `performSubmit` re-reads it after every await, so a submit awaiting its
   * pre-Enter delay when the lock engages abandons the Enter instead of
   * submitting whatever the shutdown signal left in the composer.
   */
  acquireShutdownInputLock(): () => void {
    this.shutdownLockDepth++;
    this.inputGeneration++;
    this.host.writeQueue.cancelPendingInput();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.shutdownLockDepth--;
    };
  }

  /**
   * Throwing variant of `write` for the small-keystroke fast path. Used by the
   * fleet broadcast loop in pty-host so a synchronous EPIPE/EIO/EBADF on one
   * target produces an actionable per-target failure result instead of being
   * swallowed by `logWriteError`. Returns `{ ok: true }` on success and
   * `{ ok: false, error: NodeJS.ErrnoException }` when `pty.write()` throws.
   *
   * Falls back to `write()` (queued chunking) for payloads >512 bytes; the
   * caller cannot meaningfully observe failures in the chunked async path,
   * but broadcast keystrokes are always single chunks so this is fine.
   */
  tryWrite(data: string, traceId?: string): { ok: boolean; error?: NodeJS.ErrnoException } {
    const terminal = this.host.terminalInfo;
    if (this.isInputLocked) {
      // EBUSY rather than EBADF: the PTY is fine, it is just not ours to write
      // to right now. Broadcast surfaces this per target instead of silently
      // dropping the keystroke into a terminal mid-teardown.
      return {
        ok: false,
        error: Object.assign(new Error("terminal is shutting down"), { code: "EBUSY" }),
      };
    }
    if (terminal.isExited) {
      return {
        ok: false,
        error: Object.assign(new Error("terminal exited"), { code: "EBADF" }),
      };
    }
    if (!terminal.ptyProcess) {
      return {
        ok: false,
        error: Object.assign(new Error("terminal has no pty process"), { code: "EBADF" }),
      };
    }

    if (data.length > 512) {
      // Long payloads queue through chunkInput in write(); we lose precise
      // per-call failure visibility but that path isn't used by broadcast.
      this.write(data, traceId);
      return { ok: true };
    }

    terminal.lastInputTime = Date.now();
    if (traceId !== undefined) {
      terminal.traceId = traceId || undefined;
    }
    if (this.host.analysis.hasMonitor()) {
      if (isFocusReport(data)) {
        this.handleFocusInput();
      } else {
        this.host.analysis.notifyInput(data);
      }
    }

    try {
      terminal.ptyProcess.write(data);
      return { ok: true };
    } catch (error) {
      this.host.logWriteError(error, { operation: "tryWrite", traceId });
      return { ok: false, error: error as NodeJS.ErrnoException };
    }
  }

  write(data: string, traceId?: string): void {
    const terminal = this.host.terminalInfo;
    if (this.isInputLocked) {
      return;
    }
    terminal.lastInputTime = Date.now();

    if (terminal.isExited) {
      return;
    }

    if (!terminal.ptyProcess) {
      return;
    }

    if (traceId !== undefined) {
      terminal.traceId = traceId || undefined;
    }

    if (this.host.analysis.hasMonitor()) {
      if (isFocusReport(data)) {
        this.handleFocusInput();
      } else {
        this.host.analysis.notifyInput(data);
      }
    }

    const bracketedPaste = isBracketedPaste(data);
    const identityWatcher = this.host.identityWatcher;
    const seededCommandText = identityWatcher.seededCommandText;
    const isSeededLaunchCommandSubmit =
      !bracketedPaste &&
      seededCommandText !== undefined &&
      /[\r\n]/.test(data) &&
      normalizeShellCommandText(data) === seededCommandText;
    // Shell input capture is only meaningless when a live AGENT owns the PTY
    // (agents have their own input semantics). A plain process badge (npm,
    // pnpm, docker, etc.) does not change the shell semantics — the shell
    // is still the direct recipient of typed commands, and the next command
    // must still be visible to the fallback detector so a follow-up
    // `pnpm build` can re-identify the badge. #5813
    const canCaptureShellInput =
      !bracketedPaste && (terminal.detectedAgentId === undefined || isSeededLaunchCommandSubmit);
    const submittedCommandText = canCaptureShellInput
      ? identityWatcher.captureInput(data)
      : undefined;
    const pendingFallbackIdentity = identityWatcher.pendingFallbackIdentity;
    const isAgentUiPromptResponse =
      !bracketedPaste &&
      submittedCommandText === undefined &&
      pendingFallbackIdentity?.agentType !== undefined &&
      (!identityWatcher.isFallbackCommitted || identityWatcher.hasAgentUiPromptFalsePositive());

    if (!bracketedPaste && /[\r\n]/.test(data)) {
      if (identityWatcher.consumeSuppressSignal()) {
        // Suppression consumed — performSubmit() armed it for its body+enter sequence.
      } else if (isAgentUiPromptResponse) {
        logIdentityDebug(
          `[IdentityDebug] shell-submit-skip term=${this.host.id.slice(-8)} reason=agent-ui-prompt`
        );
      } else {
        identityWatcher.onShellSubmit(submittedCommandText, {
          allowWhenAgentDetected: isSeededLaunchCommandSubmit,
        });
      }
      if (isSeededLaunchCommandSubmit) {
        identityWatcher.clearSeededCommandText();
      }
    }

    if (bracketedPaste) {
      try {
        terminal.ptyProcess.write(data);
      } catch (error) {
        this.host.logWriteError(error, { operation: "write(bracketed-paste)", traceId });
      }
      return;
    }

    if (data.length <= 512) {
      try {
        terminal.ptyProcess.write(data);
      } catch (error) {
        this.host.logWriteError(error, { operation: "write(fast-path)", traceId });
      }
      return;
    }

    this.host.writeQueue.enqueueChunked(data);
  }

  submit(text: string): void {
    if (this.isInputLocked || this.host.terminalInfo.isExited) {
      return;
    }

    // Immediately notify activity monitor of the submission so the working
    // state transitions before the async write sequence in performSubmit().
    // Without this, the split between body write and Enter write causes the
    // character-by-character detection in onInput() to miss the submission.
    if (this.host.analysis.hasMonitor() && text.trim().length > 0) {
      this.host.analysis.notifySubmission();
    }

    this.host.writeQueue.submit(text);
  }

  /**
   * Stage `text` into the terminal's input WITHOUT submitting it — the no-Enter
   * counterpart to {@link submit}. Reuses the same bracketed-paste / soft-newline
   * encoding `performSubmit` uses for the body, then stops: no Enter is written
   * and no output-settle bookkeeping runs. Multi-line text is always wrapped
   * (bracketed paste when supported, soft newlines otherwise) so a stray `\n`
   * can't trigger the shell-submit detection in {@link write} and auto-execute a
   * line. Trailing newlines in `text` are dropped — staging never submits. Used
   * by `host.sendToActiveAgent(text, { submit: false })` (#10558).
   */
  stage(text: string): void {
    const terminal = this.host.terminalInfo;
    if (this.isInputLocked || terminal.isExited || !terminal.ptyProcess) {
      return;
    }
    const normalized = normalizeSubmitText(text);
    const { body } = splitTrailingNewlines(normalized);
    if (body.length === 0) {
      return;
    }
    terminal.lastInputTime = Date.now();
    const useBracketedPaste = body.includes("\n") || body.length > PASTE_THRESHOLD_CHARS;
    if (useBracketedPaste && supportsBracketedPaste(terminal)) {
      const pasteBody = body.replace(/\n/g, "\r");
      this.write(`${BRACKETED_PASTE_START}${pasteBody}${BRACKETED_PASTE_END}`);
    } else if (body.includes("\n")) {
      this.write(body.replace(/\n/g, getSoftNewlineSequence(terminal)));
    } else {
      this.write(body);
    }
  }

  async performSubmit(text: string): Promise<void> {
    const terminal = this.host.terminalInfo;
    // Re-checked after every await below: a shutdown lock taken mid-submit must
    // abandon the trailing Enter, or it submits whatever the teardown signal
    // left in the composer (#11851).
    const generation = this.inputGeneration;
    if (this.isInputLocked) {
      return;
    }
    terminal.lastInputTime = Date.now();

    if (terminal.isExited) {
      return;
    }

    if (!terminal.ptyProcess) {
      return;
    }

    // Notify activity monitor at execution time (not just enqueue time) to ensure
    // the working state transition happens even for queued submissions that execute
    // after a potential idle transition. Issue #2185.
    if (this.host.analysis.hasMonitor() && text.trim().length > 0) {
      this.host.analysis.notifySubmission();
    }

    const normalized = normalizeSubmitText(text);
    const { body, enterCount } = splitTrailingNewlines(normalized);
    const enterSuffix = "\r".repeat(enterCount);

    const identityWatcher = this.host.identityWatcher;

    if (body.length === 0) {
      identityWatcher.armSuppressSignal();
      this.write(enterSuffix);
      return;
    }

    const useBracketedPaste = body.includes("\n") || body.length > PASTE_THRESHOLD_CHARS;
    const useOutputSettle = !supportsBracketedPaste(terminal);

    if (useBracketedPaste && supportsBracketedPaste(terminal)) {
      const pasteBody = body.replace(/\n/g, "\r");
      const payload = `${BRACKETED_PASTE_START}${pasteBody}${BRACKETED_PASTE_END}`;
      this.write(payload);
    } else {
      if (body.includes("\n") && !supportsBracketedPaste(terminal)) {
        const softNewline = getSoftNewlineSequence(terminal);
        this.write(body.replace(/\n/g, softNewline));
      } else {
        this.write(body);
      }
    }

    await this.host.writeQueue.waitForInputWriteDrain();

    if (this.isInputLocked || this.inputGeneration !== generation) {
      return;
    }

    if (useOutputSettle) {
      await this.host.writeQueue.waitForOutputSettle({
        debounceMs: OUTPUT_SETTLE_DEBOUNCE_MS,
        maxWaitMs: OUTPUT_SETTLE_MAX_WAIT_MS,
        pollMs: OUTPUT_SETTLE_POLL_INTERVAL_MS,
      });
    } else {
      await delay(getSubmitEnterDelay(terminal));
    }

    if (!this.host.terminalInfo.ptyProcess) {
      return;
    }

    if (this.isInputLocked || this.inputGeneration !== generation) {
      return;
    }

    identityWatcher.armSuppressSignal();
    identityWatcher.onShellSubmit(body);
    this.write(enterSuffix);
  }

  // Side-effects shared by both PTY write paths when xterm forwards a CSI I/O
  // focus report. Mirrors the resize handler's pattern (notifyResize +
  // agentOutputTemperature.noteResize): open the ActivityMonitor suppression
  // window AND invalidate the agentOutputTemperature baseline so the redraw
  // that follows the focus event is treated as a fresh comparison point.
  private handleFocusInput(): void {
    this.host.analysis.notifyFocus();
  }
}

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
  constructor(private readonly host: TerminalInputControllerHost) {}

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
    if (this.host.terminalInfo.isExited) {
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
    if (terminal.isExited || !terminal.ptyProcess) {
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

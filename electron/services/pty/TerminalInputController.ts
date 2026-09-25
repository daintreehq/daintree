import { stat } from "fs/promises";
import type { TerminalInfo } from "./types.js";
import type { TerminalSubmitGuard } from "../../../shared/types/pty-host.js";
import { evaluateWakeGate, type WakeGateSnapshot } from "../../../shared/utils/terminalWakeGate.js";
import type { AnalysisBackend } from "./analysis/AnalysisBackend.js";
import { IdentityWatcher, normalizeShellCommandText } from "./IdentityWatcher.js";
import { WriteQueue, type SubmitExecutionContext } from "./WriteQueue.js";
import { logIdentityDebug } from "./identityDebug.js";
import {
  normalizeSubmitText,
  splitTrailingNewlines,
  supportsBracketedPaste,
  supportsImagePathInput,
  getSoftNewlineSequence,
  getSubmitEnterDelay,
  isBracketedPaste,
  isFocusReport,
  isTerminalReportOnly,
  delay,
  PASTE_THRESHOLD_CHARS,
  OUTPUT_SETTLE_DEBOUNCE_MS,
  OUTPUT_SETTLE_MAX_WAIT_MS,
  OUTPUT_SETTLE_POLL_INTERVAL_MS,
} from "./terminalInput.js";
import { formatWithBracketedPaste } from "../../../shared/utils/terminalInputProtocol.js";
import {
  isImageAttachmentPath,
  splitImageInputSegments,
  type ImageInputSegment,
} from "../../../shared/utils/imageAttachmentInput.js";

const IMAGE_STAT_TIMEOUT_MS = 1000;

/**
 * Whether `filePath` is a regular file, answered `false` rather than awaited
 * forever: a stat on a dead network mount can hang, and this runs inside the
 * submit lane every terminal on the host shares a process with.
 */
async function isRegularFile(filePath: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), IMAGE_STAT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      stat(filePath).then(
        (stats) => stats.isFile(),
        () => false
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface AgentOwner {
  agentId: string | undefined;
  incarnation: number;
}

export interface TerminalInputControllerHost {
  readonly id: string;
  readonly terminalInfo: TerminalInfo;
  readonly analysis: AnalysisBackend;
  readonly identityWatcher: IdentityWatcher;
  readonly writeQueue: WriteQueue;
  logWriteError(error: unknown, context: { operation: string; traceId?: string }): void;
}

function wakeGateSnapshot(terminal: TerminalInfo): WakeGateSnapshot {
  return {
    agentState: terminal.agentState,
    waitingReason: terminal.waitingReason,
    lastStateChange: terminal.lastStateChange,
    lastTypedInputAt: terminal.lastTypedInputAt,
    detectedAgentId: terminal.detectedAgentId,
    isExited: terminal.isExited,
    hasPty: !terminal.wasKilled && !!terminal.ptyProcess,
  };
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
   * between two presses — a live keystroke, the trailing Enter of an in-flight
   * submit — either lands in the agent's composer or breaks the press
   * economics the gate depends on.
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
   * Falls back to `write()` for payloads >512 bytes, which reports failures
   * through `logWriteError` rather than returning them; broadcast keystrokes
   * are always well under that, so the distinction never bites in practice.
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
      // write() swallows the throw into logWriteError, so we lose precise
      // per-call failure visibility — but that path isn't used by broadcast.
      this.write(data, traceId);
      return { ok: true };
    }

    terminal.lastInputTime = Date.now();
    if (!isTerminalReportOnly(data)) terminal.lastTypedInputAt = terminal.lastInputTime;
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
    this.writeInternal(data, traceId, false);
  }

  /**
   * `write` for the submit path, which needs a synchronous pty failure to be a
   * failure rather than a log line (#12337).
   *
   * `write()` swallows a throwing `ptyProcess.write()` into `logWriteError`, so
   * a genuine EPIPE/EIO never reached `WriteQueue`'s `failed` branch and the
   * submission looked as though it had gone out. Raw typing keeps that
   * forgiving behaviour — a dropped keystroke is not worth tearing anything
   * down — while a tracked submission propagates.
   *
   * `tryWrite()` is not the substitute: it falls back to `write()` above 512
   * bytes, which is precisely the size a context injection lands in.
   *
   * Returns whether the data was handed to node-pty. `false` means an entry
   * guard declined (input locked, terminal exited, no handle) — nothing was
   * written and nothing threw.
   */
  private writeStrict(data: string, traceId?: string): boolean {
    return this.writeInternal(data, traceId, true);
  }

  private writeInternal(data: string, traceId: string | undefined, rethrow: boolean): boolean {
    const terminal = this.host.terminalInfo;
    if (this.isInputLocked) {
      return false;
    }
    terminal.lastInputTime = Date.now();
    // `rethrow` is the submit lane's own body and Enter, which leave the
    // composer empty once the Enter lands; only raw input can leave a draft.
    if (!rethrow && !isTerminalReportOnly(data)) {
      terminal.lastTypedInputAt = terminal.lastInputTime;
    }

    if (terminal.isExited) {
      return false;
    }

    if (!terminal.ptyProcess) {
      return false;
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
        if (rethrow) throw error;
        this.host.logWriteError(error, { operation: "write(bracketed-paste)", traceId });
        return false;
      }
      return true;
    }

    // Everything goes straight to the PTY, large payloads included. Daintree
    // used to re-split anything over 512 bytes into 50-byte chunks on a 5ms
    // interval; node-pty owns that queueing now (microsoft/node-pty#831), so
    // the extra lane only added latency — roughly 10KB/s, which is what made
    // large context injections take tens of seconds (#11875).
    try {
      terminal.ptyProcess.write(data);
    } catch (error) {
      if (rethrow) throw error;
      this.host.logWriteError(error, { operation: "write(direct)", traceId });
      return false;
    }
    return true;
  }

  submit(
    text: string,
    token?: string,
    onPtyWritten?: () => void,
    guard?: TerminalSubmitGuard,
    imagePaths?: readonly string[]
  ): void {
    if (this.isInputLocked || this.host.terminalInfo.isExited) {
      // Refused before the lane sees it, so `WriteQueue` never mints a record.
      // Answer the token here instead of leaving the caller to read `unknown`.
      if (token !== undefined) this.host.writeQueue.noteRejectedSubmission(token);
      return;
    }

    // Immediately notify activity monitor of the submission so the working
    // state transitions before the async write sequence in performSubmit().
    // Without this, the split between body write and Enter write causes the
    // character-by-character detection in onInput() to miss the submission.
    //
    // Not for a guarded submission (#12491): marking the agent working here
    // would fail its own admission check. performSubmit notifies at execution
    // time, which for a guarded line is only once it has been admitted.
    if (guard === undefined && this.host.analysis.hasMonitor() && text.trim().length > 0) {
      this.host.analysis.notifySubmission();
    }

    const admit =
      guard === "settled-prompt"
        ? () =>
            !this.isInputLocked &&
            evaluateWakeGate(wakeGateSnapshot(this.host.terminalInfo)).kind === "ready"
        : undefined;
    this.host.writeQueue.submit(text, token, onPtyWritten, admit, imagePaths);
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
      // The shared formatter, not a hand-built wrapper: it neutralises ESC in
      // the body, so text carrying its own `ESC[201~` cannot end the paste
      // early and hand the rest to the program as typed input.
      this.write(formatWithBracketedPaste(body.replace(/\n/g, "\r")));
    } else if (body.includes("\n")) {
      this.write(body.replace(/\n/g, getSoftNewlineSequence(terminal)));
    } else {
      this.write(body);
    }
  }

  /**
   * `ctx.markPtyWritten()` is the ONLY positive signal this method produces.
   * Every guard below returns normally, so a resolved promise is compatible
   * with nothing having been written at all — which is the silent loss #12337
   * is about.
   */
  async performSubmit(text: string, ctx?: SubmitExecutionContext): Promise<void> {
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
      if (this.writeStrict(enterSuffix)) ctx?.markPtyWritten();
      return;
    }

    const useBracketedPaste = body.includes("\n") || body.length > PASTE_THRESHOLD_CHARS;
    const useOutputSettle = !supportsBracketedPaste(terminal);
    // Only a submission carrying images pays the await: every other body is
    // still written in the same tick it reached the lane. Both the typing
    // baseline and the recipient are taken before it, so input or an agent
    // exit during the stat or between pastes is seen rather than absorbed.
    const carriesImages = ctx?.imagePaths !== undefined && ctx.imagePaths.length > 0;
    const owner = this.captureOwner();
    const typedBeforeBody = terminal.lastTypedInputAt;
    const imageSegments = carriesImages
      ? await this.resolveImageSegments(body, ctx?.imagePaths ?? [])
      : null;
    if (carriesImages) {
      if (!this.isStillOwnedBy(generation, owner)) return;
      // A guarded line whose composer was typed into while the stat ran is
      // abandoned before any of it is written, as it would be before its Enter.
      if (ctx?.abandonEnterOnInput === true && terminal.lastTypedInputAt !== typedBeforeBody) {
        return;
      }
    }

    let bodyWritten: boolean;
    if (imageSegments) {
      const outcome = await this.writeImageSegments(imageSegments, generation, owner);
      if (outcome === "abandoned") return;
      bodyWritten = outcome === "written";
    } else if (useBracketedPaste && supportsBracketedPaste(terminal)) {
      // See `stage`: an unsanitised body could close the paste itself, and
      // whatever follows would reach the agent as keystrokes, submits included.
      // Page-derived text (DOM ids, labels) reaches here from SvelteKit Tools.
      const payload = formatWithBracketedPaste(body.replace(/\n/g, "\r"));
      bodyWritten = this.writeStrict(payload);
    } else if (body.includes("\n") && !supportsBracketedPaste(terminal)) {
      const softNewline = getSoftNewlineSequence(terminal);
      bodyWritten = this.writeStrict(body.replace(/\n/g, softNewline));
    } else {
      bodyWritten = this.writeStrict(body);
    }

    // A declined body write means the pty went away between the entry guards
    // and here. Nothing is in the composer, so stop rather than sending a bare
    // Enter after it.
    if (!bodyWritten) {
      return;
    }
    const typedAtBodyWrite = carriesImages ? typedBeforeBody : terminal.lastTypedInputAt;

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

    // The user typed into the composer while this body sat there waiting for
    // its Enter. Submitting now would send their keystrokes as part of a line
    // they did not write, so the Enter is dropped and the record says so.
    if (
      ctx?.abandonEnterOnInput === true &&
      this.host.terminalInfo.lastTypedInputAt !== typedAtBodyWrite
    ) {
      return;
    }
    // Its requester took it back — the user stopped the watches, or turned
    // pane wakes off — while the body waited for its Enter.
    if (ctx?.isWithdrawn?.() === true) {
      return;
    }

    if (carriesImages && !this.isStillOwnedBy(generation, owner)) {
      return;
    }

    identityWatcher.armSuppressSignal();
    identityWatcher.onShellSubmit(body);
    if (this.writeStrict(enterSuffix)) ctx?.markPtyWritten();
  }

  /**
   * The body split into text and image segments when this submission carries
   * images the live agent can take as attachments (#12792), else `null` and
   * the body goes out through the ordinary single write.
   *
   * An image only becomes an attachment when its path is a local absolute
   * image path that exists as a regular file right now; anything else stays in
   * the text exactly as the composer wrote it, so a missing or remote file is
   * never announced as attached.
   */
  private async resolveImageSegments(
    body: string,
    imagePaths: readonly string[]
  ): Promise<ImageInputSegment[] | null> {
    if (!supportsImagePathInput(this.host.terminalInfo)) return null;
    const candidates = [...new Set(imagePaths.filter(isImageAttachmentPath))];
    if (candidates.length === 0) return null;
    const exists = await Promise.all(candidates.map(isRegularFile));
    const existing = new Set(candidates.filter((_, index) => exists[index]));
    // Filtered from the original list, not the deduplicated one: two chips for
    // the same image are two attachments.
    const deliverable = imagePaths.filter((imagePath) => existing.has(imagePath));
    if (deliverable.length === 0) return null;
    const segments = splitImageInputSegments(body, deliverable);
    return segments.some((segment) => segment.kind === "image") ? segments : null;
  }

  /**
   * Write the body as separate pastes, in order: each image as a bracketed
   * paste whose whole payload is its raw path — the only shape the CLIs turn
   * into an attachment — and the text between them as bracketed pastes of
   * their own. Text is wrapped even when short so a segment starting with `/`
   * or `@` cannot open the CLI's command or file picker.
   *
   * Consecutive writes are spaced by the agent's submit delay: an Ink CLI
   * drops input written in the same tick as the last, and a Ratatui CLI would
   * fold back-to-back pastes into one burst, burying the path in text again.
   */
  private async writeImageSegments(
    segments: readonly ImageInputSegment[],
    generation: number,
    owner: AgentOwner
  ): Promise<"written" | "declined" | "abandoned"> {
    const gapMs = getSubmitEnterDelay(this.host.terminalInfo);
    let first = true;
    for (const segment of segments) {
      const payload = segment.kind === "image" ? segment.path : segment.text.replace(/\n/g, "\r");
      if (payload.length === 0) continue;
      if (!first) {
        await delay(gapMs);
        if (!this.isStillOwnedBy(generation, owner)) return "abandoned";
      }
      if (!this.writeStrict(formatWithBracketedPaste(payload))) {
        return first ? "declined" : "abandoned";
      }
      first = false;
    }
    return first ? "declined" : "written";
  }

  /**
   * Whether a paced image submission may keep writing: the pty is still there,
   * no shutdown or newer generation has taken the input, and the agent it was
   * addressed to still owns the terminal. An agent that exited into its shell
   * mid-sequence must not receive the rest of the pastes, let alone the Enter.
   */
  private isStillOwnedBy(generation: number, owner: AgentOwner): boolean {
    const terminal = this.host.terminalInfo;
    if (!terminal.ptyProcess || terminal.isExited) return false;
    if (this.isInputLocked || this.inputGeneration !== generation) return false;
    // The incarnation as well as the id: the same agent relaunched in this pty
    // is a new session that did not ask for the rest of these pastes.
    return (
      terminal.detectedAgentId === owner.agentId && terminal.agentIncarnation === owner.incarnation
    );
  }

  private captureOwner(): AgentOwner {
    const terminal = this.host.terminalInfo;
    return { agentId: terminal.detectedAgentId, incarnation: terminal.agentIncarnation };
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

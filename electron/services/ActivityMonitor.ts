import {
  AgentPatternDetector,
  stripAnsi,
  type PatternDetectionConfig,
  type PatternDetectionResult,
} from "./pty/AgentPatternDetector.js";
import { PatternBuffer } from "./pty/PatternBuffer.js";
import { InputTracker } from "./pty/InputTracker.js";
import { OutputVolumeDetector } from "./pty/OutputVolumeDetector.js";
import { HighOutputDetector } from "./pty/HighOutputDetector.js";
import { WorkingSignalDebouncer } from "./pty/WorkingSignalDebouncer.js";
import { LineRewriteDetector, isStatusLineRewrite } from "./pty/LineRewriteDetector.js";
import {
  detectPrompt,
  detectPromptLexeme,
  DEFAULT_PROMPT_PATTERNS,
  type PromptDetectorConfig,
} from "./pty/PromptDetector.js";
import { detectCompletion } from "./pty/CompletionDetector.js";
import { CompletionTimer } from "./pty/CompletionTimer.js";
import { BootDetector } from "./pty/BootDetector.js";
import { classifyWaitingReason } from "./pty/WaitingReasonClassifier.js";
import type { WaitingReason } from "../../shared/types/agent.js";

export interface ProcessStateValidator {
  hasActiveChildren(): boolean;
  getDescendantsCpuUsage(): number;
}

export interface PatternDetector {
  detect(output: string): PatternDetectionResult;
}

export interface ActivityMonitorOptions {
  ignoredInputSequences?: string[];
  processStateValidator?: ProcessStateValidator;
  outputActivityDetection?: {
    enabled?: boolean;
    windowMs?: number;
    minFrames?: number;
    minBytes?: number;
  };
  highOutputThreshold?: {
    enabled?: boolean;
    windowMs?: number;
    bytesPerSecond?: number;
    recoveryEnabled?: boolean;
    recoveryDelayMs?: number;
  };
  agentId?: string;
  patternConfig?: PatternDetectionConfig;
  bootCompletePatterns?: RegExp[];
  patternBufferSize?: number;
  getVisibleLines?: (n: number) => string[];
  getCursorLine?: () => string | null;
  initialState?: "busy" | "idle";
  skipInitialStateEmit?: boolean;
  promptPatterns?: RegExp[];
  promptHintPatterns?: RegExp[];
  completionPatterns?: RegExp[];
  completionConfidence?: number;
  promptScanLineCount?: number;
  promptConfidence?: number;
  idleDebounceMs?: number;
  promptFastPathMinQuietMs?: number;
  inputConfirmMs?: number;
  maxNoPromptIdleMs?: number;
  lineRewriteDetection?: {
    enabled?: boolean;
    windowMs?: number;
    minRewrites?: number;
  };
  pollingIntervalMs?: number;
  workingRecoveryDelayMs?: number;
  pollingMaxBootMs?: number;
  maxWorkingSilenceMs?: number;
  maxCpuHighEscapeMs?: number;
  maxWaitingSilenceMs?: number;
  onWaitingTimeout?: (id: string, spawnedAt: number) => void;
}

export interface ActivityStateMetadata {
  trigger: "input" | "output" | "pattern" | "timeout" | "dispose";
  patternConfidence?: number;
  waitingReason?: WaitingReason;
  sessionCost?: number;
  sessionTokens?: number;
}

export class ActivityMonitor {
  private state: "busy" | "idle" = "idle";
  private isDisposed = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_DEBOUNCE_MS: number;
  private readonly PROMPT_FAST_PATH_MIN_QUIET_MS: number;
  private readonly PROMPT_DEBOUNCE_MS = 500;
  private readonly PROMPT_QUIET_MS = 200;
  private readonly PROMPT_HISTORY_FALLBACK_MS = 3000;
  private readonly WORKING_HOLD_MS = 1500;
  private readonly SPINNER_ACTIVE_MS = 1500;
  private readonly COMPLETION_HOLD_MS = 500;
  private readonly WORKING_INDICATOR_TTL_MS = 5000;
  private readonly MAX_WORKING_SILENCE_MS: number;
  private readonly MAX_WAITING_SILENCE_MS: number;
  private readonly MAX_CPU_HIGH_ESCAPE_MS: number;
  private readonly CPU_HIGH_THRESHOLD = 10;
  private readonly CPU_LOW_THRESHOLD = 3;
  private isCpuHigh = false;
  private cpuHighSince = 0;
  private idleSince = 0;
  private waitingWatchdogFired = false;
  private lastPatternResultAt = 0;
  private workingHoldUntil = 0;

  // Subsystem instances
  private readonly inputTracker: InputTracker;
  private readonly patternBuf: PatternBuffer;
  private readonly outputVolumeDetector: OutputVolumeDetector;
  private readonly highOutputDetector: HighOutputDetector;
  private readonly workingSignalDebouncer: WorkingSignalDebouncer;
  private readonly lineRewriteDetector: LineRewriteDetector;
  private readonly completionTimer: CompletionTimer;
  private readonly bootDetector: BootDetector;

  // Resize suppression
  private resizeSuppressUntil = 0;

  private readonly onWaitingTimeout?: (id: string, spawnedAt: number) => void;
  private readonly processStateValidator?: ProcessStateValidator;
  private lastActivityTimestamp = Date.now();
  private lastDataTimestamp = Date.now();
  private lastOutputActivityAt = 0;
  private lastWorkingIndicatorTimestamp = 0;
  private promptStableSince = 0;
  private readonly SLEEP_DETECTION_THRESHOLD_MS = 5000;
  private pendingStateRevalidation = false;

  // Pattern-based detection
  private patternDetector?: AgentPatternDetector;
  private lastPatternResult?: PatternDetectionResult;
  private readonly getVisibleLines?: (n: number) => string[];
  private readonly getCursorLine?: () => string | null;
  private pollingInterval?: ReturnType<typeof setInterval>;
  private watchdogInterval?: ReturnType<typeof setInterval>;

  // Polling config
  private readonly POLLING_MAX_BOOT_MS: number;

  // Prompt/completion config
  private readonly promptDetectorConfig: PromptDetectorConfig;
  private readonly completionPatterns: RegExp[];
  private readonly completionConfidence: number;

  // State preservation for project switch
  private readonly skipInitialStateEmit: boolean;

  // Polling interval configuration
  private POLLING_INTERVAL_MS: number;

  constructor(
    private terminalId: string,
    private spawnedAt: number,
    private onStateChange: (
      id: string,
      spawnedAt: number,
      state: "busy" | "idle" | "completed",
      metadata?: ActivityStateMetadata
    ) => void,
    options?: ActivityMonitorOptions
  ) {
    this.IDLE_DEBOUNCE_MS = options?.idleDebounceMs ?? 4000;
    this.PROMPT_FAST_PATH_MIN_QUIET_MS = options?.promptFastPathMinQuietMs ?? 3000;
    this.POLLING_MAX_BOOT_MS = options?.pollingMaxBootMs ?? 15000;
    this.MAX_WORKING_SILENCE_MS = options?.maxWorkingSilenceMs ?? 180000;
    this.MAX_CPU_HIGH_ESCAPE_MS = options?.maxCpuHighEscapeMs ?? 60000;
    this.MAX_WAITING_SILENCE_MS = options?.maxWaitingSilenceMs ?? 600000;

    this.idleSince = Date.now();

    this.processStateValidator = options?.processStateValidator;
    this.onWaitingTimeout = options?.onWaitingTimeout;

    // Initialize subsystems
    this.inputTracker = new InputTracker({
      ignoredInputSequences: options?.ignoredInputSequences,
      inputConfirmMs: options?.inputConfirmMs,
    });

    this.patternBuf = new PatternBuffer(options?.patternBufferSize ?? 10000);

    this.outputVolumeDetector = new OutputVolumeDetector(options?.outputActivityDetection);

    this.highOutputDetector = new HighOutputDetector(options?.highOutputThreshold);

    this.workingSignalDebouncer = new WorkingSignalDebouncer(
      options?.workingRecoveryDelayMs ?? 1500
    );

    this.lineRewriteDetector = new LineRewriteDetector(options?.lineRewriteDetection);

    this.completionTimer = new CompletionTimer();

    this.bootDetector = new BootDetector(options?.bootCompletePatterns);

    // Pattern detector
    if (options?.patternConfig || options?.agentId) {
      this.patternDetector = new AgentPatternDetector(options.agentId, options.patternConfig);
    }
    this.getVisibleLines = options?.getVisibleLines;
    this.getCursorLine = options?.getCursorLine;

    // Prompt config
    const promptPatterns =
      options?.promptPatterns?.length && options.promptPatterns.length > 0
        ? options.promptPatterns
        : DEFAULT_PROMPT_PATTERNS;
    this.promptDetectorConfig = {
      promptPatterns,
      promptHintPatterns: options?.promptHintPatterns ?? [],
      promptScanLineCount: options?.promptScanLineCount ?? 6,
      promptConfidence: options?.promptConfidence ?? 0.85,
    };

    // Completion config
    this.completionPatterns = options?.completionPatterns ?? [];
    this.completionConfidence = options?.completionConfidence ?? 0.9;

    // State preservation
    this.state = options?.initialState ?? "idle";
    this.skipInitialStateEmit = options?.skipInitialStateEmit ?? false;

    // Polling interval
    this.POLLING_INTERVAL_MS = options?.pollingIntervalMs ?? 50;

    // Lightweight watchdog interval: runs the waiting watchdog check periodically
    // even when there's no output/activity. 5s keeps overhead negligible while
    // ensuring hung waiting states are caught within a reasonable window.
    this.watchdogInterval = setInterval(() => this.checkWaitingWatchdog(Date.now()), 5000);
  }

  onInput(data: string): void {
    if (this.isDisposed) return;
    const now = Date.now();
    const result = this.inputTracker.process(data, now);

    if (result.kind === "ignored" || result.kind === "no-enter") {
      return;
    }

    // result.kind === "enter"
    if (!this.getVisibleLines) {
      this.becomeBusy({ trigger: "input" });
      return;
    }

    if (result.hadText) {
      this.becomeBusy({ trigger: "input" }, now);
      return;
    }

    // Empty input: use confirmation window
    this.inputTracker.pendingInputWasNonEmpty = false;
    this.inputTracker.pendingInputUntil = now + this.inputTracker.INPUT_CONFIRM_MS;
  }

  onData(data?: string): void {
    if (this.isDisposed) return;
    const now = Date.now();
    const timeSinceLastData = now - this.lastDataTimestamp;

    if (timeSinceLastData > this.SLEEP_DETECTION_THRESHOLD_MS) {
      this.pendingStateRevalidation = true;
    }

    this.lastDataTimestamp = now;

    const isLikelyUserEcho = data ? this.inputTracker.isLikelyUserEcho(data, now) : false;
    const isCosmeticRedraw = data ? isStatusLineRewrite(data) : false;

    if (data && !isLikelyUserEcho && !isCosmeticRedraw) {
      this.lastActivityTimestamp = now;
    }

    if (this.pendingStateRevalidation && this.state === "busy") {
      this.pendingStateRevalidation = false;
      this.revalidateStateAfterWake();
    }

    if (data && !isLikelyUserEcho && isCosmeticRedraw) {
      // Spinner/status-line rewrite — latch lastSpinnerDetectedAt for polling's isSpinnerActive()
      // check, but do not call becomeBusy() here. Entry into working state requires pattern
      // detection or sustained output, not cosmetic line rewrites alone.
      this.lineRewriteDetector.update(data, now);
    }

    // For polling-enabled terminals: check raw stream for patterns FIRST
    if (data && this.getVisibleLines && !isLikelyUserEcho && !isCosmeticRedraw) {
      this.patternBuf.update(data);
      const bufferText = stripAnsi(this.patternBuf.getText());
      const lowerBuffer = bufferText.toLowerCase();

      // Check for boot-complete patterns in the rolling buffer
      if (!this.bootDetector.hasExitedBootState) {
        if (this.bootDetector.check(bufferText, false, 0, Infinity)) {
          // Boot detected via pattern in rolling buffer
        }
      }

      // Check for working patterns in the rolling buffer
      const patternResult = this.patternDetector
        ? this.patternDetector.detect(bufferText)
        : undefined;
      if (patternResult) {
        this.lastPatternResult = patternResult;
        this.lastPatternResultAt = now;
      }
      const isWorking = patternResult
        ? patternResult.isWorking
        : lowerBuffer.includes("esc to interrupt") || lowerBuffer.includes("esc to cancel");

      if (
        isWorking &&
        !this.isResizeSuppressed(now) &&
        (this.state === "busy" ||
          this.inputTracker.pendingInputUntil > 0 ||
          !this.inputTracker.isRecentUserInput(now))
      ) {
        if (this.state === "busy" || this.inputTracker.pendingInputUntil > 0) {
          this.becomeBusy({
            trigger: "pattern",
            patternConfidence: patternResult?.confidence ?? 0.9,
          });
        } else {
          if (this.workingSignalDebouncer.shouldTriggerRecovery(now, true)) {
            this.becomeBusy({
              trigger: "pattern",
              patternConfidence: patternResult?.confidence ?? 0.9,
            });
          }
        }
      }
    }

    if (!data || isLikelyUserEcho) {
      return;
    }

    if (isCosmeticRedraw) {
      return;
    }

    if (this.state === "busy") {
      this.resetDebounceTimer();
    }

    // Update pattern buffer and check for working patterns (non-polling terminals only)
    if (!this.getVisibleLines && this.patternDetector) {
      this.patternBuf.update(data);
      const patternResult = this.patternDetector.detect(this.patternBuf.getText());
      this.lastPatternResult = patternResult;
      this.lastPatternResultAt = now;

      if (patternResult.isWorking) {
        this.lastWorkingIndicatorTimestamp = now;
      }

      if (patternResult.isWorking && !this.isResizeSuppressed(now)) {
        this.becomeBusyFromPattern(patternResult.confidence, now);
      }
    }

    const dataLength = Buffer.byteLength(data, "utf8");

    if (this.isResizeSuppressed(now)) {
      return;
    }

    // Track high output activity
    this.highOutputDetector.update(dataLength, now);

    // High output recovery
    if (this.state === "idle" && this.highOutputDetector.shouldTriggerRecovery(now)) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    // Volume-based output detection
    if (!this.outputVolumeDetector.enabled) {
      return;
    }

    if (this.outputVolumeDetector.update(dataLength, now)) {
      this.becomeBusyFromOutput(now);
    }
  }

  isHighOutputActivity(now: number = Date.now()): boolean {
    return this.highOutputDetector.isHighOutput(now);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Emit final idle transition if still busy — ensures renderer never stays stuck in "working"
    if (this.state === "busy") {
      this.state = "idle";
      try {
        this.onStateChange(this.terminalId, this.spawnedAt, "idle", { trigger: "dispose" });
      } catch {
        // Callback failure must not prevent cleanup
      }
    }
    this.waitingWatchdogFired = false;
    this.idleSince = 0;
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = undefined;
    }
    this.stopPolling();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.completionTimer.dispose();
    this.inputTracker.reset();
    this.outputVolumeDetector.reset();
    this.highOutputDetector.reset();
    this.workingSignalDebouncer.reset();
    this.lineRewriteDetector.reset();
    this.patternBuf.reset();
    this.bootDetector.reset();
    this.resizeSuppressUntil = 0;
    this.lastPatternResult = undefined;
    this.lastPatternResultAt = 0;
    this.isCpuHigh = false;
    this.cpuHighSince = 0;
    this.workingHoldUntil = 0;
    this.lastDataTimestamp = 0;
    this.lastOutputActivityAt = 0;
    this.lastWorkingIndicatorTimestamp = 0;
    this.promptStableSince = 0;
  }

  getLastPatternResult(): PatternDetectionResult | undefined {
    return this.lastPatternResult;
  }

  reconfigure(agentId?: string, patternConfig?: PatternDetectionConfig): void {
    if (this.isDisposed) return;

    this.patternDetector =
      agentId || patternConfig ? new AgentPatternDetector(agentId, patternConfig) : undefined;

    // Old buffer contents and TTL-gated pattern results belong to the previous
    // detector — leaving any of them would let stale matches hold working state
    // through the debounce callback's WORKING_INDICATOR_TTL_MS window. Timing
    // fields (lastActivityTimestamp, promptStableSince, CPU hysteresis,
    // workingHoldUntil, debounceTimer) are preserved so busy/idle classification
    // stays coherent across the swap.
    this.patternBuf.reset();
    this.lastPatternResult = undefined;
    this.lastPatternResultAt = 0;
    this.lastWorkingIndicatorTimestamp = 0;
  }

  notifySubmission(): void {
    if (this.isDisposed) return;
    this.becomeBusy({ trigger: "input" });
  }

  notifyResize(suppressionMs = 1000): void {
    this.resizeSuppressUntil = Date.now() + suppressionMs;
    this.highOutputDetector.resetWindow();
  }

  private isResizeSuppressed(now: number): boolean {
    return this.resizeSuppressUntil > 0 && now < this.resizeSuppressUntil;
  }

  getState(): "busy" | "idle" {
    return this.state;
  }

  startPolling(): void {
    if (this.isDisposed) return;
    if (!this.getVisibleLines || this.pollingInterval) return;

    this.bootDetector.pollingStartTime = Date.now();

    if (this.skipInitialStateEmit) {
      this.bootDetector.hasExitedBootState = this.state === "idle";
      if (this.state === "busy") {
        this.recordWorkingSignal(this.bootDetector.pollingStartTime);
      }
    } else {
      this.bootDetector.hasExitedBootState = false;

      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", { trigger: "pattern" });
      this.recordWorkingSignal(this.bootDetector.pollingStartTime);
    }

    this.pollingInterval = setInterval(() => this.runPollingCycle(), this.POLLING_INTERVAL_MS);
  }

  private runPollingCycle(): void {
    if (this.isDisposed) return;
    if (!this.getVisibleLines) return;

    const now = Date.now();

    const scanCount = !this.bootDetector.hasExitedBootState
      ? Math.max(this.promptDetectorConfig.promptScanLineCount, 50)
      : Math.max(this.promptDetectorConfig.promptScanLineCount, 15);
    const lines = this.getVisibleLines!(scanCount);
    const cursorLine = this.getCursorLine?.() ?? null;
    const strippedText = stripAnsi(lines.join(" "));
    const text = strippedText.toLowerCase();
    const quietForMs = now - this.lastActivityTimestamp;
    const isQuietForIdle = quietForMs >= this.IDLE_DEBOUNCE_MS;

    const patternResult = this.patternDetector
      ? this.patternDetector.detectFromLines(lines)
      : undefined;
    if (patternResult) {
      this.lastPatternResult = patternResult;
      this.lastPatternResultAt = now;
    }

    const isWorkingPattern = patternResult
      ? patternResult.isWorking
      : this.skipInitialStateEmit
        ? false
        : text.includes("esc to interrupt") || text.includes("esc to cancel");

    const allowHistoryScan = quietForMs >= this.PROMPT_HISTORY_FALLBACK_MS;
    const promptResult = detectPrompt(lines, this.promptDetectorConfig, cursorLine, {
      allowHistoryScan,
    });
    const isPrompt = promptResult.isPrompt;
    if (isPrompt) {
      if (this.promptStableSince === 0) {
        this.promptStableSince = now;
      }
    } else {
      this.promptStableSince = 0;
    }

    const suppressWorkingPatternForPromptTyping =
      isPrompt &&
      this.inputTracker.pendingInputUntil === 0 &&
      this.inputTracker.isRecentUserInput(now);
    const effectiveWorkingPattern = suppressWorkingPatternForPromptTyping
      ? false
      : isWorkingPattern;

    // Check for boot completion
    if (!this.bootDetector.hasExitedBootState) {
      const timeSinceBoot = now - this.bootDetector.pollingStartTime;
      if (
        this.bootDetector.check(strippedText, isPrompt, timeSinceBoot, this.POLLING_MAX_BOOT_MS)
      ) {
        // Boot complete, continue to normal detection
      } else {
        return; // Still booting, stay busy
      }
    }

    // Update CPU hysteresis state once per polling cycle
    this.updateCpuHighState(now);

    // Safety timeout: if no PTY output for MAX_WORKING_SILENCE_MS, force idle
    if (this.isWorkingSilenceTimeout(now)) {
      this.state = "idle";
      this.idleSince = now;
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", { trigger: "timeout" });
      return;
    }

    // Waiting watchdog: if idle (waiting) > MAX_WAITING_SILENCE_MS and agent process is dead
    this.checkWaitingWatchdog(now);

    const hasRecentOutputActivity =
      this.lastOutputActivityAt > 0 &&
      now - this.lastOutputActivityAt <= this.outputVolumeDetector.windowMs;
    const isSpinnerActive = this.lineRewriteDetector.isSpinnerActive(now, this.SPINNER_ACTIVE_MS);
    const isOutputQuiet = quietForMs >= this.PROMPT_QUIET_MS;
    const promptStableForMs = this.promptStableSince === 0 ? 0 : now - this.promptStableSince;

    const hasHighOutputActivity = this.highOutputDetector.isHighOutput(now);

    const shouldAllowPromptStability =
      isPrompt &&
      isOutputQuiet &&
      !isSpinnerActive &&
      !hasRecentOutputActivity &&
      !hasHighOutputActivity;
    const shouldPreferPrompt =
      shouldAllowPromptStability && promptStableForMs >= this.PROMPT_DEBOUNCE_MS;

    if (effectiveWorkingPattern && !shouldAllowPromptStability && !isQuietForIdle) {
      this.recordWorkingSignal(now);
    }

    const isWorkingSignal =
      isSpinnerActive ||
      hasRecentOutputActivity ||
      hasHighOutputActivity ||
      (effectiveWorkingPattern &&
        !shouldPreferPrompt &&
        !shouldAllowPromptStability &&
        !isQuietForIdle);
    if (isWorkingSignal) {
      this.promptStableSince = 0;
    }

    if (this.inputTracker.pendingInputUntil > 0) {
      if (isWorkingSignal && this.inputTracker.pendingInputWasNonEmpty) {
        this.inputTracker.pendingInputUntil = 0;
        this.inputTracker.pendingInputWasNonEmpty = false;
        const metadata = effectiveWorkingPattern
          ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
          : { trigger: "output" as const };
        this.becomeBusy(metadata, now);
        return;
      } else if (isPrompt && !this.inputTracker.pendingInputWasNonEmpty) {
        this.inputTracker.pendingInputUntil = 0;
        this.inputTracker.pendingInputWasNonEmpty = false;
      } else if (now >= this.inputTracker.pendingInputUntil) {
        this.inputTracker.pendingInputUntil = 0;
        this.inputTracker.pendingInputWasNonEmpty = false;
        this.becomeBusy({ trigger: "input" }, now);
        return;
      }
    }

    const resizeSuppressed = this.isResizeSuppressed(now);

    if (
      !resizeSuppressed &&
      this.state === "idle" &&
      this.highOutputDetector.shouldTriggerRecovery(now)
    ) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    if (isWorkingSignal && !resizeSuppressed) {
      if (
        this.state !== "busy" &&
        this.inputTracker.pendingInputUntil === 0 &&
        this.inputTracker.isRecentUserInput(now)
      ) {
        this.workingSignalDebouncer.shouldTriggerRecovery(now, false);
        return;
      }
      if (this.state !== "busy") {
        if (
          this.bootDetector.hasExitedBootState &&
          this.workingSignalDebouncer.shouldTriggerRecovery(now, true)
        ) {
          const metadata = effectiveWorkingPattern
            ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
            : { trigger: "output" as const };
          this.becomeBusy(metadata, now);
        } else if (!this.bootDetector.hasExitedBootState) {
          const metadata = effectiveWorkingPattern
            ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
            : { trigger: "output" as const };
          this.becomeBusy(metadata, now);
        }
      }
      return;
    } else {
      this.workingSignalDebouncer.shouldTriggerRecovery(now, false);
    }

    // Completion detection
    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      this.completionPatterns.length > 0
    ) {
      const completionResult = detectCompletion(
        lines,
        this.completionPatterns,
        this.completionConfidence,
        this.promptDetectorConfig.promptScanLineCount
      );
      if (completionResult.isCompletion) {
        this.transitionToCompleted(
          completionResult.confidence,
          completionResult.extractedCost,
          completionResult.extractedTokens
        );
        return;
      }
    }

    // Prompt fast-path: when the prompt is stable and no working signals are active,
    // exit busy immediately rather than waiting the full IDLE_DEBOUNCE_MS. This keeps
    // the idle transition snappy after the prompt appears, even when IDLE_DEBOUNCE_MS
    // has been raised to cover LLM API call silence gaps.
    // Default: 3s quiet to avoid premature idle during inter-tool-call gaps (Claude
    // bursts with 1-3s pauses, Codex has 3-5s gaps — Issue #3606). Agents with
    // deterministic completion markers (e.g. Cursor, 700ms) can use a lower value
    // via promptFastPathMinQuietMs in AgentDetectionConfig.
    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      shouldPreferPrompt &&
      quietForMs >= this.PROMPT_FAST_PATH_MIN_QUIET_MS &&
      now >= this.workingHoldUntil &&
      !this.isCpuHighAndNotDeadlined(now) &&
      !(this.inputTracker.pendingInputUntil > 0 && now < this.inputTracker.pendingInputUntil)
    ) {
      this.state = "idle";
      this.idleSince = now;
      this.patternBuf.clear();
      const waitingReason = classifyWaitingReason(lines, true);
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "pattern",
        waitingReason,
      });
      return;
    }

    // Prompt lexeme fallback: when output has stalled and the last visible line
    // contains a prompt lexeme (?, [y/N], keyword+colon, "press enter"), detect
    // as a prompt with medium confidence. This catches interactive prompts that
    // don't match any configured promptPattern or promptHintPattern.
    const LEXEME_STALL_MIN_QUIET_MS = 3000;
    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      !isPrompt &&
      !effectiveWorkingPattern &&
      !isSpinnerActive &&
      !hasRecentOutputActivity &&
      !hasHighOutputActivity &&
      quietForMs >= LEXEME_STALL_MIN_QUIET_MS &&
      now >= this.workingHoldUntil &&
      !this.isCpuHighAndNotDeadlined(now) &&
      !(this.inputTracker.pendingInputUntil > 0 && now < this.inputTracker.pendingInputUntil)
    ) {
      const candidateLine =
        cursorLine && stripAnsi(cursorLine).trim().length > 0
          ? cursorLine
          : lines.length > 0
            ? lines[lines.length - 1]
            : "";
      const lexemeResult = detectPromptLexeme(candidateLine);
      if (lexemeResult.isPrompt) {
        this.state = "idle";
        this.idleSince = now;
        this.patternBuf.clear();
        this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
          trigger: "pattern",
          patternConfidence: 0.7,
        });
        return;
      }
    }

    if (
      this.state === "busy" &&
      !this.completionTimer.emitted &&
      isQuietForIdle &&
      now >= this.workingHoldUntil &&
      !hasHighOutputActivity &&
      !this.isCpuHighAndNotDeadlined(now) &&
      !(this.inputTracker.pendingInputUntil > 0 && now < this.inputTracker.pendingInputUntil)
    ) {
      this.state = "idle";
      this.idleSince = now;
      this.patternBuf.clear();
      const waitingReason = classifyWaitingReason(lines, isPrompt);
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "timeout",
        waitingReason,
      });
    }
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    this.workingSignalDebouncer.reset();
  }

  setPollingInterval(intervalMs: number): void {
    if (this.isDisposed) return;
    if (this.POLLING_INTERVAL_MS === intervalMs) {
      return;
    }

    const wasPolling = this.pollingInterval !== undefined;
    this.POLLING_INTERVAL_MS = intervalMs;

    if (wasPolling && this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = setInterval(() => this.runPollingCycle(), this.POLLING_INTERVAL_MS);
    }
  }

  private recordWorkingSignal(now: number): void {
    this.workingHoldUntil = Math.max(this.workingHoldUntil, now + this.WORKING_HOLD_MS);
  }

  private transitionToCompleted(
    confidence: number,
    sessionCost?: number,
    sessionTokens?: number
  ): void {
    this.completionTimer.emit(() => {
      if (this.isDisposed) return;
      // Guard: ignore stale timer if a new busy cycle started or completion was reset
      if (!this.completionTimer.emitted || this.state !== "busy") {
        return;
      }
      this.completionTimer.emitted = false;
      this.state = "idle";
      this.idleSince = Date.now();
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "pattern",
        patternConfidence: 0.85,
      });
    }, this.COMPLETION_HOLD_MS);

    this.onStateChange(this.terminalId, this.spawnedAt, "completed", {
      trigger: "pattern",
      patternConfidence: confidence,
      sessionCost,
      sessionTokens,
    });
  }

  private becomeBusyFromPattern(confidence: number, now: number): void {
    this.becomeBusy({ trigger: "pattern", patternConfidence: confidence }, now);
  }

  private revalidateStateAfterWake(): void {
    const actuallyBusy = this.hasActiveChildrenSafe();
    if (actuallyBusy === null) {
      return;
    }
    if (!actuallyBusy && this.state === "busy") {
      let waitingReason: WaitingReason | undefined;
      if (this.getVisibleLines) {
        const lines = this.getVisibleLines(
          Math.max(this.promptDetectorConfig.promptScanLineCount, 15)
        );
        const cursorLine = this.getCursorLine?.() ?? null;
        const promptResult = detectPrompt(lines, this.promptDetectorConfig, cursorLine, {
          allowHistoryScan: true,
        });
        if (!promptResult.isPrompt) {
          return;
        }
        waitingReason = classifyWaitingReason(lines, promptResult.isPrompt);
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.state = "idle";
      this.idleSince = Date.now();
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle", {
        trigger: "timeout",
        waitingReason,
      });
    }
  }

  private becomeBusy(metadata: ActivityStateMetadata, now: number = Date.now()): void {
    if (this.isDisposed) return;
    this.inputTracker.clearPendingInput();
    if (metadata.trigger === "input") {
      this.lastActivityTimestamp = now;
    }
    this.lastDataTimestamp = now;
    this.recordWorkingSignal(now);
    this.resetDebounceTimer();
    this.waitingWatchdogFired = false;

    // Reset completion state for the new work cycle
    this.completionTimer.reset();

    if (this.state !== "busy") {
      this.state = "busy";
      this.idleSince = now;
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", metadata);
    }
  }

  private becomeBusyFromOutput(now: number): void {
    if (
      this.state !== "busy" &&
      this.inputTracker.pendingInputUntil === 0 &&
      this.inputTracker.isRecentUserInput(now)
    ) {
      return;
    }

    const actuallyBusy = this.hasActiveChildrenSafe();
    if (actuallyBusy === false) {
      return;
    }

    this.lastOutputActivityAt = now;
    this.becomeBusy({ trigger: "output" }, now);
  }

  private resetDebounceTimer(): void {
    if (this.isDisposed) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (this.isDisposed) {
        this.debounceTimer = null;
        return;
      }

      if (this.getVisibleLines) {
        this.debounceTimer = null;
        return;
      }

      // Safety timeout: if no PTY output for MAX_WORKING_SILENCE_MS, force idle
      if (this.isWorkingSilenceTimeout(Date.now())) {
        this.state = "idle";
        this.idleSince = Date.now();
        this.patternBuf.clear();
        this.onStateChange(this.terminalId, this.spawnedAt, "idle", { trigger: "timeout" });
        this.debounceTimer = null;
        return;
      }

      // Check process liveness first — if the terminal is dead, don't reschedule
      // based on stale pattern state
      const actuallyBusy = this.hasActiveChildrenSafe();
      if (actuallyBusy === false) {
        this.state = "idle";
        this.idleSince = Date.now();
        this.patternBuf.clear();
        this.onStateChange(this.terminalId, this.spawnedAt, "idle");
        this.debounceTimer = null;
        return;
      }

      if (actuallyBusy) {
        this.resetDebounceTimer();
        return;
      }

      // actuallyBusy === null (no validator) — fall through to pattern/TTL checks
      // CPU high prevents idle transition even without a definitive hasActiveChildren answer
      const now = Date.now();
      if (this.isCpuHighAndNotDeadlined(now)) {
        this.resetDebounceTimer();
        return;
      }

      // Stale pattern results are expired via the same TTL as working indicators
      if (
        this.lastPatternResult?.isWorking &&
        now - this.lastPatternResultAt < this.WORKING_INDICATOR_TTL_MS
      ) {
        this.resetDebounceTimer();
        return;
      }

      if (
        this.lastWorkingIndicatorTimestamp > 0 &&
        Date.now() - this.lastWorkingIndicatorTimestamp < this.WORKING_INDICATOR_TTL_MS
      ) {
        this.resetDebounceTimer();
        return;
      }

      if (this.isHighOutputActivity()) {
        this.resetDebounceTimer();
        return;
      }

      this.state = "idle";
      this.idleSince = Date.now();
      this.patternBuf.clear();
      this.onStateChange(this.terminalId, this.spawnedAt, "idle");
      this.debounceTimer = null;
    }, this.IDLE_DEBOUNCE_MS);
  }

  private isWorkingSilenceTimeout(now: number): boolean {
    if (this.state !== "busy") return false;
    if (now - this.lastDataTimestamp < this.MAX_WORKING_SILENCE_MS) return false;
    // Non-polling terminals have no boot phase; polling terminals must exit boot first
    if (this.getVisibleLines && !this.bootDetector.hasExitedBootState) return false;
    // High CPU prevents premature silence timeout — but only up to the escape deadline
    if (this.isCpuHighAndNotDeadlined(now)) return false;
    return true;
  }

  private checkWaitingWatchdog(now: number): void {
    if (this.state !== "idle") return;
    if (this.waitingWatchdogFired) return;
    if (now - this.idleSince < this.MAX_WAITING_SILENCE_MS) return;
    if (!this.onWaitingTimeout) return;

    const hasChildren = this.hasActiveChildrenSafe();
    if (hasChildren !== false) return;

    this.waitingWatchdogFired = true;
    this.onWaitingTimeout(this.terminalId, this.spawnedAt);
  }

  private hasActiveChildrenSafe(): boolean | null {
    if (!this.processStateValidator) {
      return null;
    }
    try {
      return this.processStateValidator.hasActiveChildren();
    } catch (error) {
      if (process.env.DAINTREE_VERBOSE) {
        console.warn("[ActivityMonitor] Process state validation failed:", error);
      }
      return true;
    }
  }

  private getCpuUsageSafe(): number | null {
    if (!this.processStateValidator) {
      return null;
    }
    try {
      return this.processStateValidator.getDescendantsCpuUsage();
    } catch (error) {
      if (process.env.DAINTREE_VERBOSE) {
        console.warn("[ActivityMonitor] CPU usage query failed:", error);
      }
      return null;
    }
  }

  private updateCpuHighState(now: number): void {
    const cpu = this.getCpuUsageSafe();
    if (cpu === null) return;
    if (this.isCpuHigh) {
      if (cpu < this.CPU_LOW_THRESHOLD) {
        this.isCpuHigh = false;
        this.cpuHighSince = 0;
      }
    } else {
      if (cpu >= this.CPU_HIGH_THRESHOLD) {
        this.isCpuHigh = true;
        this.cpuHighSince = now;
      }
    }
  }

  private isCpuHighAndNotDeadlined(now: number): boolean {
    this.updateCpuHighState(now);
    if (!this.isCpuHigh) return false;
    return now - this.cpuHighSince < this.MAX_CPU_HIGH_ESCAPE_MS;
  }
}

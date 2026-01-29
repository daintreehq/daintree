import {
  AgentPatternDetector,
  stripAnsi,
  type PatternDetectionConfig,
  type PatternDetectionResult,
} from "./pty/AgentPatternDetector.js";

export interface ProcessStateValidator {
  hasActiveChildren(): boolean;
}

export interface PatternDetector {
  detect(output: string): PatternDetectionResult;
}

export interface ActivityMonitorOptions {
  ignoredInputSequences?: string[];
  processStateValidator?: ProcessStateValidator;
  /**
   * Volume-based output activity detection configuration.
   * Triggers busy state when output exceeds thresholds within a time window.
   */
  outputActivityDetection?: {
    enabled?: boolean;
    windowMs?: number;
    minFrames?: number;
    minBytes?: number;
  };
  /**
   * High output activity threshold configuration.
   * Enabled by default. Used to prevent premature waiting transitions and to recover from incorrect waiting state.
   * When output exceeds these thresholds over the specified window:
   * - Debounce timer will NOT transition to idle
   * - Recovery from waiting/idle to working will occur
   */
  highOutputThreshold?: {
    /** Enable high output detection (default: true) */
    enabled?: boolean;
    /** Time window in milliseconds to measure output rate (default: 500ms) */
    windowMs?: number;
    /** Minimum bytes per second to consider "high output" (default: 2048 bytes/sec) */
    bytesPerSecond?: number;
    /** Enable recovery from waiting state on sustained high output (default: true) */
    recoveryEnabled?: boolean;
    /** Minimum sustained high output duration before recovery in ms (default: 500ms) */
    recoveryDelayMs?: number;
  };
  /**
   * Agent ID for pattern-based detection (e.g., "claude", "gemini", "codex").
   * If provided, enables pattern detection using built-in patterns.
   */
  agentId?: string;
  /**
   * Custom pattern detection configuration.
   * Overrides built-in patterns when provided.
   */
  patternConfig?: PatternDetectionConfig;
  /**
   * Boot-complete patterns (agent-ready indicators).
   * Overrides built-in patterns when provided.
   */
  bootCompletePatterns?: RegExp[];
  /**
   * Size of the output buffer to retain for pattern detection (default: 2000 chars).
   */
  patternBufferSize?: number;
  /**
   * Callback to get the last N lines from xterm (already ANSI-cleaned).
   * If provided, polling uses this instead of raw buffer.
   */
  getVisibleLines?: (n: number) => string[];
  /**
   * Callback to get the current cursor line from xterm.
   * Used to confirm prompt visibility for waiting detection.
   */
  getCursorLine?: () => string | null;
  /**
   * Initial state for the monitor (default: "idle").
   * When resuming after project switch, set to previous state to avoid spurious transitions.
   */
  initialState?: "busy" | "idle";
  /**
   * Skip initial state emission on startPolling().
   * Used when resuming after project switch to preserve terminal's agent state.
   */
  skipInitialStateEmit?: boolean;
  /**
   * Prompt patterns that indicate the agent is waiting for input.
   */
  promptPatterns?: RegExp[];
  /**
   * Prompt hint patterns that indicate an empty input prompt is visible.
   * Safe to scan from visible lines even when the cursor line is active output.
   */
  promptHintPatterns?: RegExp[];
  /**
   * Number of lines to scan for prompt detection (default: 6).
   */
  promptScanLineCount?: number;
  /**
   * Confidence level when prompt pattern matches (default: 0.85).
   */
  promptConfidence?: number;
  /**
   * Debounce window before transitioning to idle (default: 2500ms).
   */
  idleDebounceMs?: number;
  /**
   * Input confirmation window before marking busy (default: 1000ms).
   */
  inputConfirmMs?: number;
  /**
   * Fallback idle timeout when no prompt signal is detected (default: 120000ms).
   */
  maxNoPromptIdleMs?: number;
  /**
   * Line rewrite detection for spinner-like output.
   */
  lineRewriteDetection?: {
    enabled?: boolean;
    windowMs?: number;
    minRewrites?: number;
  };
  /**
   * Polling interval for pattern detection (default: 50ms for active, 500ms for background).
   * Used to reduce CPU usage for background project terminals.
   */
  pollingIntervalMs?: number;
}

export interface ActivityStateMetadata {
  trigger: "input" | "output" | "pattern";
  /**
   * Confidence level when trigger is "pattern" (0-1).
   */
  patternConfidence?: number;
}

interface PromptDetectionResult {
  isPrompt: boolean;
  confidence: number;
  matchedText?: string;
}

export class ActivityMonitor {
  private state: "busy" | "idle" = "idle";
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_DEBOUNCE_MS: number;
  private readonly INPUT_CONFIRM_MS: number;
  private readonly PROMPT_DEBOUNCE_MS = 200;
  private readonly PROMPT_QUIET_MS = 200;
  private readonly PROMPT_HISTORY_FALLBACK_MS = 3000;
  private readonly WORKING_HOLD_MS = 200;
  private readonly SPINNER_ACTIVE_MS = 1500;
  private inBracketedPaste = false;
  private partialEscape = "";
  private pasteStartTime = 0;
  private readonly PASTE_TIMEOUT_MS = 5000;
  private readonly ignoredInputSequences: Set<string>;
  private pendingInputUntil = 0;
  private pendingInputWasNonEmpty = false;
  private pendingInputChars = 0;
  private workingHoldUntil = 0;

  // Volume-based output detection
  private readonly outputDetectionEnabled: boolean;
  private readonly outputWindowMs: number;
  private readonly outputMinFrames: number;
  private readonly outputMinBytes: number;
  private outputWindowStart = 0;
  private outputFramesInWindow = 0;
  private outputBytesInWindow = 0;

  // High output activity threshold (prevents premature idle and enables recovery)
  private readonly highOutputEnabled: boolean;
  private readonly highOutputWindowMs: number;
  private readonly highOutputBytesPerSecond: number;
  private readonly highOutputRecoveryEnabled: boolean;
  private readonly highOutputRecoveryDelayMs: number;
  private highOutputWindowStart = 0;
  private highOutputBytesInWindow = 0;
  private sustainedHighOutputSince = 0;

  private readonly processStateValidator?: ProcessStateValidator;
  private lastActivityTimestamp = Date.now();
  private lastOutputActivityAt = 0;
  private lastSpinnerDetectedAt = 0;
  private promptStableSince = 0;
  private readonly SLEEP_DETECTION_THRESHOLD_MS = 5000;
  private pendingStateRevalidation = false;

  // Pattern-based detection
  private readonly patternDetector?: AgentPatternDetector;
  private patternBuffer = "";
  private readonly PATTERN_BUFFER_SIZE: number;
  private lastPatternResult?: PatternDetectionResult;
  private readonly getVisibleLines?: (n: number) => string[];
  private readonly getCursorLine?: () => string | null;
  private pollingInterval?: ReturnType<typeof setInterval>;

  // Polling debounce state
  private readonly POLLING_MAX_BOOT_MS = 15000; // Max 15s boot time before forcing boot complete
  private pollingStartTime = 0; // When polling started
  private hasExitedBootState = false; // Whether we've completed initial boot

  // Prompt detection
  private readonly promptPatterns: RegExp[];
  private readonly promptHintPatterns: RegExp[];
  private readonly promptScanLineCount: number;
  private readonly promptConfidence: number;

  // Line rewrite detection
  private readonly rewriteDetectionEnabled: boolean;
  private readonly rewriteWindowMs: number;
  private readonly rewriteMinCount: number;
  private rewriteWindowStart = 0;
  private rewriteCount = 0;

  // State preservation for project switch
  private readonly skipInitialStateEmit: boolean;

  // Polling interval configuration
  private POLLING_INTERVAL_MS: number;

  // Boot detection patterns - when these appear, the agent is ready
  private static readonly BOOT_COMPLETE_PATTERNS = [
    /claude\s+code\s+v?\d/i, // Claude Code vX.X.X or Claude Code X.X.X
    /openai[-\s]+codex/i, // OpenAI Codex / OpenAI-Codex
    /codex\s+v/i, // Codex vX.X.X variant
    /type\s+your\s+message/i, // Gemini CLI ready prompt
  ];
  private static readonly DEFAULT_PROMPT_PATTERNS = [/^\s*[>›❯⟩$#%]\s*/i];
  private readonly bootCompletePatterns: RegExp[];

  constructor(
    private terminalId: string,
    private spawnedAt: number,
    private onStateChange: (
      id: string,
      spawnedAt: number,
      state: "busy" | "idle",
      metadata?: ActivityStateMetadata
    ) => void,
    options?: ActivityMonitorOptions
  ) {
    this.ignoredInputSequences = new Set(options?.ignoredInputSequences ?? ["\x1b\r"]);
    this.processStateValidator = options?.processStateValidator;
    this.PATTERN_BUFFER_SIZE = options?.patternBufferSize ?? 2000;
    this.IDLE_DEBOUNCE_MS = options?.idleDebounceMs ?? 2500;
    this.INPUT_CONFIRM_MS = options?.inputConfirmMs ?? 1000;

    // Volume-based output detection config
    const outputDefaults = {
      enabled: false,
      windowMs: 500,
      minFrames: 3,
      minBytes: 2048,
    };
    const outputConfig = { ...outputDefaults, ...options?.outputActivityDetection };
    this.outputDetectionEnabled = outputConfig.enabled;
    this.outputWindowMs = outputConfig.windowMs;
    this.outputMinFrames = outputConfig.minFrames;
    this.outputMinBytes = outputConfig.minBytes;

    // High output activity threshold config (prevents premature idle, enables recovery)
    const highOutputDefaults = {
      enabled: true,
      windowMs: 500,
      bytesPerSecond: 2048,
      recoveryEnabled: true,
      recoveryDelayMs: 500,
    };
    const highOutputConfig = { ...highOutputDefaults, ...options?.highOutputThreshold };
    this.highOutputEnabled = highOutputConfig.enabled;
    this.highOutputWindowMs = highOutputConfig.windowMs;
    this.highOutputBytesPerSecond = highOutputConfig.bytesPerSecond;
    this.highOutputRecoveryEnabled = highOutputConfig.recoveryEnabled;
    this.highOutputRecoveryDelayMs = highOutputConfig.recoveryDelayMs;

    // Initialize pattern detector if agent ID or custom config is provided
    if (options?.patternConfig || options?.agentId) {
      this.patternDetector = new AgentPatternDetector(options.agentId, options.patternConfig);
    }
    this.getVisibleLines = options?.getVisibleLines;
    this.getCursorLine = options?.getCursorLine;
    this.bootCompletePatterns =
      options?.bootCompletePatterns?.length && options.bootCompletePatterns.length > 0
        ? options.bootCompletePatterns
        : ActivityMonitor.BOOT_COMPLETE_PATTERNS;
    this.promptPatterns =
      options?.promptPatterns?.length && options.promptPatterns.length > 0
        ? options.promptPatterns
        : ActivityMonitor.DEFAULT_PROMPT_PATTERNS;
    this.promptHintPatterns = options?.promptHintPatterns ?? [];
    this.promptScanLineCount = options?.promptScanLineCount ?? 6;
    this.promptConfidence = options?.promptConfidence ?? 0.85;

    const rewriteDefaults = { enabled: true, windowMs: 500, minRewrites: 2 };
    const rewriteConfig = { ...rewriteDefaults, ...options?.lineRewriteDetection };
    this.rewriteDetectionEnabled = rewriteConfig.enabled;
    this.rewriteWindowMs = rewriteConfig.windowMs;
    this.rewriteMinCount = rewriteConfig.minRewrites;

    // State preservation for project switch - allows resuming without spurious state emissions
    this.state = options?.initialState ?? "idle";
    this.skipInitialStateEmit = options?.skipInitialStateEmit ?? false;

    // Polling interval - default 50ms for active terminals
    this.POLLING_INTERVAL_MS = options?.pollingIntervalMs ?? 50;
  }

  /**
   * Called when user sends input to the terminal.
   * Tracks Enter key intent while avoiding false positives from pastes.
   */
  onInput(data: string): void {
    // Ignore synthetic "soft newline" sequences (e.g. Shift+Enter in the renderer).
    if (this.ignoredInputSequences.has(data)) {
      return;
    }

    // Fail-safe: exit paste mode if it has been open too long
    if (
      this.inBracketedPaste &&
      this.pasteStartTime > 0 &&
      Date.now() - this.pasteStartTime > this.PASTE_TIMEOUT_MS
    ) {
      this.inBracketedPaste = false;
      this.pasteStartTime = 0;
    }

    // Prepend any partial escape sequence from the previous call
    const fullData = this.partialEscape + data;
    this.partialEscape = "";

    const { scanData, partialEscape } = this.splitTrailingEscapeSequence(fullData);
    this.partialEscape = partialEscape;

    if (scanData.length === 0) {
      return;
    }

    if (this.ignoredInputSequences.has(scanData)) {
      return;
    }

    let sawEnter = false;
    let inputHadText = false;
    for (let i = 0; i < scanData.length; i++) {
      // Check for Bracketed Paste Start: \x1b[200~
      if (scanData[i] === "\x1b" && scanData.substring(i, i + 6) === "\x1b[200~") {
        this.inBracketedPaste = true;
        this.pasteStartTime = Date.now();
        this.pendingInputChars = Math.max(this.pendingInputChars, 1);
        i += 5;
        continue;
      }

      // Check for Bracketed Paste End: \x1b[201~
      if (scanData[i] === "\x1b" && scanData.substring(i, i + 6) === "\x1b[201~") {
        this.inBracketedPaste = false;
        this.pasteStartTime = 0;
        i += 5;
        continue;
      }

      if (scanData[i] === "\x1b") {
        const escapeEnd = this.findEscapeSequenceEnd(scanData.slice(i));
        if (escapeEnd !== null) {
          i += escapeEnd - 1;
          continue;
        }
      }

      // Only trigger busy on Enter if we are NOT inside a paste
      const char = scanData[i];
      if (this.inBracketedPaste) {
        if (char !== "\r" && char !== "\n") {
          this.pendingInputChars = Math.max(1, this.pendingInputChars + 1);
        }
        continue;
      }

      if ((char === "\r" || char === "\n") && !this.inBracketedPaste) {
        sawEnter = true;
        inputHadText = this.pendingInputChars > 0;
        break;
      }

      if (char === "\x7f" || char === "\b") {
        this.pendingInputChars = Math.max(0, this.pendingInputChars - 1);
        continue;
      }
      if (char === "\x15" || char === "\x17") {
        this.pendingInputChars = 0;
        continue;
      }
      if (char >= " " || char === "\t") {
        this.pendingInputChars += 1;
      }
    }

    if (!sawEnter) {
      return;
    }

    this.pendingInputChars = 0;

    const now = Date.now();
    if (!this.getVisibleLines) {
      this.becomeBusy({ trigger: "input" });
      return;
    }

    // For polling-enabled terminals: immediately transition to busy on Enter with non-empty input.
    // This provides instant feedback when the user submits a command, rather than waiting for
    // working signals or timeout confirmation. Empty Enter still uses the confirmation window
    // to avoid false positives when the user presses Enter at a prompt without typing.
    // Issue #1638
    if (inputHadText) {
      this.becomeBusy({ trigger: "input" }, now);
      return;
    }

    // Empty input: use confirmation window to check if a prompt appears (no-op)
    this.pendingInputWasNonEmpty = false;
    this.pendingInputUntil = now + this.INPUT_CONFIRM_MS;
  }

  private splitTrailingEscapeSequence(data: string): {
    scanData: string;
    partialEscape: string;
  } {
    const escIndex = data.lastIndexOf("\x1b");
    if (escIndex === -1) {
      return { scanData: data, partialEscape: "" };
    }

    const trailing = data.slice(escIndex);
    const escapeEnd = this.findEscapeSequenceEnd(trailing);
    if (escapeEnd !== null) {
      return { scanData: data, partialEscape: "" };
    }

    return {
      scanData: data.slice(0, escIndex),
      partialEscape: trailing,
    };
  }

  private findEscapeSequenceEnd(sequence: string): number | null {
    if (!sequence.startsWith("\x1b")) {
      return null;
    }
    if (sequence.length < 2) {
      return null;
    }

    const second = sequence[1];
    if (second === "[") {
      for (let i = 2; i < sequence.length; i++) {
        const code = sequence.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          return i + 1;
        }
      }
      return null;
    }

    if (second === "]") {
      const belIndex = sequence.indexOf("\x07", 2);
      if (belIndex !== -1) {
        return belIndex + 1;
      }
      const stIndex = sequence.indexOf("\x1b\\", 2);
      if (stIndex !== -1) {
        return stIndex + 2;
      }
      return null;
    }

    if (second === "P") {
      const stIndex = sequence.indexOf("\x1b\\", 2);
      if (stIndex !== -1) {
        return stIndex + 2;
      }
      return null;
    }

    if (second === "O" || second === "(" || second === ")") {
      return sequence.length >= 3 ? 3 : null;
    }

    return sequence.length >= 2 ? 2 : null;
  }

  /**
   * Called on every data event from PTY (output received).
   *
   * Key behaviors:
   * 1. Pattern detection: if working pattern found, transition to busy with high confidence
   * 2. If already busy, any output resets the debounce timer (keeps us busy)
   * 3. If idle and volume detection enabled, check output thresholds before transitioning
   * 4. System sleep/wake detection prevents stale state after laptop sleep
   */
  onData(data?: string): void {
    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivityTimestamp;

    if (timeSinceLastActivity > this.SLEEP_DETECTION_THRESHOLD_MS) {
      this.pendingStateRevalidation = true;
    }

    this.lastActivityTimestamp = now;
    if (this.pendingStateRevalidation && this.state === "busy") {
      this.pendingStateRevalidation = false;
      this.revalidateStateAfterWake();
    }

    if (data) {
      this.updateLineRewriteDetection(data, now);
    }

    // For polling-enabled terminals: check raw stream for patterns FIRST
    // This runs BEFORE the busy-state early return to ensure instant detection
    if (data && this.getVisibleLines) {
      // Use rolling buffer to catch patterns split across PTY chunks
      this.updatePatternBuffer(data);
      const bufferText = stripAnsi(this.patternBuffer);
      const lowerBuffer = bufferText.toLowerCase();

      // Check for boot-complete patterns in the rolling buffer
      if (!this.hasExitedBootState) {
        if (this.isBootComplete(bufferText)) {
          this.hasExitedBootState = true;
        }
      }

      // Check for working patterns in the rolling buffer
      const patternResult = this.patternDetector
        ? this.patternDetector.detect(bufferText)
        : undefined;
      if (patternResult) {
        this.lastPatternResult = patternResult;
      }
      const isWorking = patternResult
        ? patternResult.isWorking
        : lowerBuffer.includes("esc to interrupt") || lowerBuffer.includes("esc to cancel");
      // Only allow pattern-based busy transitions if:
      // 1. We're already busy (to keep the state), OR
      // 2. There's pending input confirmation (Enter was pressed)
      // This prevents stale patterns from triggering busy during typing. Issue #1476.
      if (isWorking && (this.state === "busy" || this.pendingInputUntil > 0)) {
        this.becomeBusy({
          trigger: "pattern",
          patternConfidence: patternResult?.confidence ?? 0.9,
        });
      }
    }

    // Now handle busy state - reset debounce timer
    if (this.state === "busy") {
      this.resetDebounceTimer();
    }

    if (!data) {
      return;
    }

    // Update pattern buffer and check for working patterns (non-polling terminals only)
    if (!this.getVisibleLines && this.patternDetector) {
      this.updatePatternBuffer(data);
      const patternResult = this.patternDetector.detect(this.patternBuffer);
      this.lastPatternResult = patternResult;

      if (patternResult.isWorking) {
        // Pattern detected - transition to busy with high confidence
        this.becomeBusyFromPattern(patternResult.confidence, now);
      }
    }

    const dataLength = Buffer.byteLength(data, "utf8");

    // Track high output activity (for preventing premature idle and recovery)
    this.updateHighOutputTracking(dataLength, now);

    // High output recovery: if we're idle and seeing sustained high output,
    // this indicates we may have incorrectly transitioned to idle/waiting.
    // Re-enter busy state when high output is sustained long enough.
    // Note: This only triggers when the external state machine is in waiting state,
    // which maps to internal "idle" state. Issue #1498.
    if (this.state === "idle" && this.shouldTriggerHighOutputRecovery(now)) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    // Volume-based output detection (when enabled)
    if (!this.outputDetectionEnabled) {
      return;
    }

    if (this.outputWindowStart === 0 || now - this.outputWindowStart > this.outputWindowMs) {
      this.outputWindowStart = now;
      this.outputFramesInWindow = 1;
      this.outputBytesInWindow = dataLength;
    } else {
      this.outputFramesInWindow++;
      this.outputBytesInWindow += dataLength;
    }

    if (
      (this.outputFramesInWindow >= this.outputMinFrames &&
        this.outputBytesInWindow >= this.outputMinBytes) ||
      this.outputBytesInWindow >= this.outputMinBytes
    ) {
      this.becomeBusyFromOutput(now);
      this.resetOutputWindow();
    }
  }

  private resetOutputWindow(): void {
    this.outputWindowStart = 0;
    this.outputFramesInWindow = 0;
    this.outputBytesInWindow = 0;
  }

  /**
   * Update high output tracking and return whether we're in a high-output state.
   * Called on every data event to track output rate.
   */
  private updateHighOutputTracking(dataLength: number, now: number): void {
    if (!this.highOutputEnabled) {
      return;
    }

    // Reset window if expired or first data
    if (
      this.highOutputWindowStart === 0 ||
      now - this.highOutputWindowStart > this.highOutputWindowMs
    ) {
      this.highOutputWindowStart = now;
      this.highOutputBytesInWindow = dataLength;
      // Reset sustained tracking when window expires to prevent stale recovery
      this.sustainedHighOutputSince = 0;
    } else {
      this.highOutputBytesInWindow += dataLength;
    }
  }

  /**
   * Check if current output rate exceeds the high output threshold.
   * Returns true if:
   * 1. High output detection is enabled
   * 2. We have valid window data (window hasn't expired)
   * 3. Output rate exceeds the configured bytes per second threshold
   */
  isHighOutputActivity(now: number = Date.now()): boolean {
    if (!this.highOutputEnabled) {
      return false;
    }

    // No valid window data
    if (this.highOutputWindowStart === 0) {
      return false;
    }

    // Window expired - no recent high output
    const windowAge = now - this.highOutputWindowStart;
    if (windowAge > this.highOutputWindowMs) {
      return false;
    }

    // Calculate bytes per second based on actual window duration
    // Use a minimum window size to avoid division by tiny numbers
    const effectiveWindowMs = Math.max(windowAge, 50);
    const bytesPerSecond = (this.highOutputBytesInWindow / effectiveWindowMs) * 1000;

    return bytesPerSecond >= this.highOutputBytesPerSecond;
  }

  /**
   * Check if high output has been sustained long enough to trigger recovery.
   * Requires sustained high output for at least recoveryDelayMs milliseconds.
   */
  private shouldTriggerHighOutputRecovery(now: number): boolean {
    if (!this.highOutputEnabled || !this.highOutputRecoveryEnabled) {
      return false;
    }

    const isHighOutput = this.isHighOutputActivity(now);

    if (isHighOutput) {
      // Start tracking sustained high output if not already
      if (this.sustainedHighOutputSince === 0) {
        this.sustainedHighOutputSince = now;
      }
      // Check if sustained long enough
      return now - this.sustainedHighOutputSince >= this.highOutputRecoveryDelayMs;
    } else {
      // Reset sustained tracking when output drops
      this.sustainedHighOutputSince = 0;
      return false;
    }
  }

  private resetHighOutputWindow(): void {
    this.highOutputWindowStart = 0;
    this.highOutputBytesInWindow = 0;
    this.sustainedHighOutputSince = 0;
  }

  /**
   * Update the pattern buffer with new data, maintaining max size.
   */
  private updatePatternBuffer(data: string): void {
    this.patternBuffer += data;
    if (this.patternBuffer.length > this.PATTERN_BUFFER_SIZE) {
      this.patternBuffer = this.patternBuffer.slice(-this.PATTERN_BUFFER_SIZE);
    }
  }

  private recordWorkingSignal(now: number): void {
    this.workingHoldUntil = Math.max(this.workingHoldUntil, now + this.WORKING_HOLD_MS);
  }

  private updateLineRewriteDetection(data: string, now: number): void {
    if (!this.rewriteDetectionEnabled) {
      return;
    }

    const rewriteHits = this.countLineRewrites(data);
    if (rewriteHits === 0) {
      return;
    }

    if (this.rewriteWindowStart === 0 || now - this.rewriteWindowStart > this.rewriteWindowMs) {
      this.rewriteWindowStart = now;
      this.rewriteCount = rewriteHits;
    } else {
      this.rewriteCount += rewriteHits;
    }

    if (this.rewriteCount >= this.rewriteMinCount) {
      this.lastSpinnerDetectedAt = now;
      // Only trigger busy if already busy OR pending input (Enter was pressed). Issue #1476.
      if (this.state === "busy" || this.pendingInputUntil > 0) {
        this.becomeBusy({ trigger: "output" }, now);
      }
    }
  }

  private countLineRewrites(data: string): number {
    let count = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === "\r" && data[i + 1] !== "\n") {
        count++;
      }
    }
    if (data.includes("\x1b[2K") || data.includes("\x1b[K")) {
      count++;
    }
    return count;
  }

  private detectPrompt(
    lines: string[],
    cursorLine?: string | null,
    options?: { allowHistoryScan?: boolean }
  ): PromptDetectionResult {
    const patterns = this.promptPatterns;
    const hintPatterns = this.promptHintPatterns;
    if (patterns.length === 0 && hintPatterns.length === 0) {
      return { isPrompt: false, confidence: 0 };
    }

    const cleanCursor =
      cursorLine !== undefined && cursorLine !== null ? stripAnsi(cursorLine) : null;
    if (cleanCursor !== null) {
      for (const pattern of patterns) {
        const match = cleanCursor.match(pattern);
        if (match) {
          return {
            isPrompt: true,
            confidence: this.promptConfidence,
            matchedText: match[0],
          };
        }
      }

      for (const pattern of hintPatterns) {
        const match = cleanCursor.match(pattern);
        if (match) {
          return {
            isPrompt: true,
            confidence: this.promptConfidence,
            matchedText: match[0],
          };
        }
      }
    }

    const scanCount = Math.min(this.promptScanLineCount, lines.length);
    const scanLines = lines.slice(-scanCount);
    for (const line of scanLines) {
      const cleanLine = stripAnsi(line);
      for (const pattern of hintPatterns) {
        const match = cleanLine.match(pattern);
        if (match) {
          return {
            isPrompt: true,
            confidence: this.promptConfidence,
            matchedText: match[0],
          };
        }
      }
    }

    if (cleanCursor && cleanCursor.trim().length > 0 && !options?.allowHistoryScan) {
      return { isPrompt: false, confidence: 0 };
    }

    for (const line of scanLines) {
      const cleanLine = stripAnsi(line);
      for (const pattern of patterns) {
        const match = cleanLine.match(pattern);
        if (match) {
          return {
            isPrompt: true,
            confidence: this.promptConfidence * 0.8,
            matchedText: match[0],
          };
        }
      }
    }

    return { isPrompt: false, confidence: 0 };
  }

  private isSpinnerActive(now: number): boolean {
    return (
      this.lastSpinnerDetectedAt > 0 && now - this.lastSpinnerDetectedAt <= this.SPINNER_ACTIVE_MS
    );
  }

  /**
   * Transition to busy state based on pattern detection.
   */
  private becomeBusyFromPattern(confidence: number, now: number): void {
    this.becomeBusy({ trigger: "pattern", patternConfidence: confidence }, now);
  }

  private revalidateStateAfterWake(): void {
    const actuallyBusy = this.hasActiveChildrenSafe();
    if (actuallyBusy === null) {
      return;
    }
    if (!actuallyBusy && this.state === "busy") {
      if (this.getVisibleLines) {
        const lines = this.getVisibleLines(Math.max(this.promptScanLineCount, 15));
        const cursorLine = this.getCursorLine?.() ?? null;
        const promptResult = this.detectPrompt(lines, cursorLine, { allowHistoryScan: true });
        if (!promptResult.isPrompt) {
          return;
        }
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.state = "idle";
      this.onStateChange(this.terminalId, this.spawnedAt, "idle");
    }
  }

  private becomeBusy(metadata: ActivityStateMetadata, now: number = Date.now()): void {
    this.pendingInputUntil = 0;
    this.pendingInputWasNonEmpty = false;
    if (metadata.trigger === "input") {
      this.lastActivityTimestamp = now;
    }
    this.recordWorkingSignal(now);
    this.resetDebounceTimer();

    if (this.state !== "busy") {
      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", metadata);
    }
  }

  private becomeBusyFromOutput(now: number): void {
    // Only allow output-based busy transitions if:
    // 1. We're already busy (to keep the state via output activity), OR
    // 2. There's pending input confirmation (Enter was pressed, waiting for agent to start)
    //
    // This prevents character echoes during typing from triggering working state.
    // The key insight: output alone should CONFIRM working state after Enter,
    // not independently trigger it. Issue #1476.
    if (this.state !== "busy" && this.pendingInputUntil === 0) {
      return;
    }

    // Validate CPU activity before entering busy state from output detection.
    // This prevents character echoes during typing from triggering active state.
    // null = no validator available, allow transition (fail open for compatibility)
    // true = CPU activity detected, allow transition
    // false = no CPU activity, user is typing, deny transition
    const actuallyBusy = this.hasActiveChildrenSafe();
    if (actuallyBusy === false) {
      return;
    }

    this.lastOutputActivityAt = now;
    this.becomeBusy({ trigger: "output" }, now);
  }

  private resetDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      // Polling terminals: let polling be sole source of truth for state transitions
      if (this.getVisibleLines) {
        this.debounceTimer = null;
        return;
      }

      // Legacy: Check pattern detection first - if pattern shows working, stay busy
      if (this.lastPatternResult?.isWorking) {
        this.resetDebounceTimer();
        return;
      }

      const actuallyBusy = this.hasActiveChildrenSafe();
      if (actuallyBusy) {
        this.resetDebounceTimer();
        return;
      }

      // Prevent premature idle if high output activity is detected. Issue #1498.
      // This ensures we don't transition to waiting while still receiving substantial output.
      if (this.isHighOutputActivity()) {
        this.resetDebounceTimer();
        return;
      }

      this.state = "idle";
      this.onStateChange(this.terminalId, this.spawnedAt, "idle");
      this.debounceTimer = null;
    }, this.IDLE_DEBOUNCE_MS);
  }

  private hasActiveChildrenSafe(): boolean | null {
    if (!this.processStateValidator) {
      return null;
    }
    try {
      return this.processStateValidator.hasActiveChildren();
    } catch (error) {
      if (process.env.CANOPY_VERBOSE) {
        console.warn("[ActivityMonitor] Process state validation failed:", error);
      }
      return true;
    }
  }

  dispose(): void {
    this.stopPolling();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.inBracketedPaste = false;
    this.partialEscape = "";
    this.pasteStartTime = 0;
    this.resetOutputWindow();
    this.resetHighOutputWindow();
    this.patternBuffer = "";
    this.lastPatternResult = undefined;
    this.pollingStartTime = 0;
    this.hasExitedBootState = false;
    this.pendingInputUntil = 0;
    this.pendingInputWasNonEmpty = false;
    this.pendingInputChars = 0;
    this.workingHoldUntil = 0;
    this.lastOutputActivityAt = 0;
    this.lastSpinnerDetectedAt = 0;
    this.promptStableSince = 0;
    this.rewriteWindowStart = 0;
    this.rewriteCount = 0;
  }

  /**
   * Get the last pattern detection result (for debugging/testing).
   */
  getLastPatternResult(): PatternDetectionResult | undefined {
    return this.lastPatternResult;
  }

  getState(): "busy" | "idle" {
    return this.state;
  }

  /**
   * Check if any boot-complete pattern is present in the text.
   */
  private isBootComplete(text: string): boolean {
    return this.bootCompletePatterns.some((pattern) => pattern.test(text));
  }

  /**
   * Start polling for patterns in xterm visible lines.
   * - Starts in busy state during boot (indicator spinning) unless skipInitialStateEmit is set
   * - Boot completes when agent-ready pattern detected OR 15s timeout
   * - After boot: idle when prompt becomes visible; busy on working signals
   * This ensures the activity indicator never hides prematurely.
   *
   * When resuming after project switch (skipInitialStateEmit=true), the monitor preserves
   * the terminal's existing agent state instead of forcing a transition to busy.
   */
  startPolling(): void {
    if (!this.getVisibleLines || this.pollingInterval) return;

    this.pollingStartTime = Date.now();

    // When resuming after project switch, preserve existing state:
    // - For idle/waiting states: mark boot complete to allow normal pattern detection
    // - For busy/working states: keep boot detection active to prevent premature idle transition
    // - skipInitialStateEmit prevents the initial busy emission
    if (this.skipInitialStateEmit) {
      // Only skip boot detection if we're resuming in an idle state
      // Working states need boot protection to avoid premature waiting transitions
      this.hasExitedBootState = this.state === "idle";
      if (this.state === "busy") {
        this.recordWorkingSignal(this.pollingStartTime);
      }
      // Don't emit - preserve terminal's agent state (polling starts below)
    } else {
      this.hasExitedBootState = false;

      // Fresh start: begin in busy state and emit to sync UI
      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", { trigger: "pattern" });
      this.recordWorkingSignal(this.pollingStartTime);
    }

    this.pollingInterval = setInterval(() => this.runPollingCycle(), this.POLLING_INTERVAL_MS);
  }

  private runPollingCycle(): void {
    if (!this.getVisibleLines) return;

    const now = Date.now();

    const scanCount = Math.max(this.promptScanLineCount, 15);
    const lines = this.getVisibleLines!(scanCount);
    const cursorLine = this.getCursorLine?.() ?? null;
    const text = stripAnsi(lines.join(" ")).toLowerCase();
    const quietForMs = now - this.lastActivityTimestamp;
    const isQuietForIdle = quietForMs >= this.IDLE_DEBOUNCE_MS;

    const patternResult = this.patternDetector
      ? this.patternDetector.detectFromLines(lines)
      : undefined;
    if (patternResult) {
      this.lastPatternResult = patternResult;
    }

    // When resuming (skipInitialStateEmit), only trust explicit pattern detector
    // to avoid matching stale "esc to interrupt" text from previous runs
    const isWorkingPattern = patternResult
      ? patternResult.isWorking
      : this.skipInitialStateEmit
        ? false
        : text.includes("esc to interrupt") || text.includes("esc to cancel");

    const allowHistoryScan = quietForMs >= this.PROMPT_HISTORY_FALLBACK_MS;
    const promptResult = this.detectPrompt(lines, cursorLine, { allowHistoryScan });
    const isPrompt = promptResult.isPrompt;
    if (isPrompt) {
      if (this.promptStableSince === 0) {
        this.promptStableSince = now;
      }
    } else {
      this.promptStableSince = 0;
    }

    // Check for boot completion (agent-specific ready patterns)
    if (!this.hasExitedBootState) {
      const timeSinceBoot = now - this.pollingStartTime;
      if (isPrompt || this.isBootComplete(text) || timeSinceBoot >= this.POLLING_MAX_BOOT_MS) {
        this.hasExitedBootState = true;
      } else {
        return; // Still booting, stay busy
      }
    }

    const hasRecentOutputActivity =
      this.lastOutputActivityAt > 0 && now - this.lastOutputActivityAt <= this.outputWindowMs;
    const isSpinnerActive = this.isSpinnerActive(now);
    const isOutputQuiet = quietForMs >= this.PROMPT_QUIET_MS;
    const promptStableForMs = this.promptStableSince === 0 ? 0 : now - this.promptStableSince;

    // High output activity is a strong working signal - Issue #1498
    const hasHighOutputActivity = this.isHighOutputActivity(now);

    const shouldAllowPromptStability =
      isPrompt &&
      isOutputQuiet &&
      !isSpinnerActive &&
      !hasRecentOutputActivity &&
      !hasHighOutputActivity;
    const shouldPreferPrompt =
      shouldAllowPromptStability && promptStableForMs >= this.PROMPT_DEBOUNCE_MS;

    if (isWorkingPattern && !shouldAllowPromptStability && !isQuietForIdle) {
      this.recordWorkingSignal(now);
    }

    const isWorkingSignal =
      isSpinnerActive ||
      hasRecentOutputActivity ||
      hasHighOutputActivity || // High output activity is a working signal - Issue #1498
      (isWorkingPattern && !shouldPreferPrompt && !shouldAllowPromptStability && !isQuietForIdle);
    if (isWorkingSignal) {
      this.promptStableSince = 0;
    }

    if (this.pendingInputUntil > 0) {
      if (isWorkingSignal && this.pendingInputWasNonEmpty) {
        // Working signal detected after Enter with non-empty input - agent is processing
        // Immediately transition to busy state (Issue #1506)
        this.pendingInputUntil = 0;
        this.pendingInputWasNonEmpty = false;
        const metadata = isWorkingPattern
          ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
          : { trigger: "output" as const };
        this.becomeBusy(metadata, now);
        return;
      } else if (isPrompt && !this.pendingInputWasNonEmpty) {
        // Prompt appeared with empty input - nothing happened
        this.pendingInputUntil = 0;
        this.pendingInputWasNonEmpty = false;
      } else if (now >= this.pendingInputUntil) {
        // Timeout reached - assume working
        this.pendingInputUntil = 0;
        this.pendingInputWasNonEmpty = false;
        this.becomeBusy({ trigger: "input" }, now);
        return;
      }
    }

    // High output recovery: when idle and sustained high output detected,
    // re-enter busy state. This handles incorrect waiting transitions. Issue #1498.
    if (this.state === "idle" && this.shouldTriggerHighOutputRecovery(now)) {
      this.becomeBusy({ trigger: "output" }, now);
      return;
    }

    if (isWorkingSignal) {
      // Only allow working signal to trigger busy if:
      // 1. We're already busy (to stay busy), OR
      // 2. There's pending input (Enter was pressed, waiting for confirmation)
      // This prevents output/patterns during typing from triggering working state. Issue #1476.
      if (this.state !== "busy" && this.pendingInputUntil === 0) {
        // Not busy and no pending input - don't transition to busy
        return;
      }
      if (this.state !== "busy") {
        const metadata = isWorkingPattern
          ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
          : { trigger: "output" as const };
        this.becomeBusy(metadata, now);
      }
      return;
    }

    if (
      this.state === "busy" &&
      isQuietForIdle &&
      now >= this.workingHoldUntil &&
      !hasHighOutputActivity && // Prevent premature idle during high output - Issue #1498
      !(this.pendingInputUntil > 0 && now < this.pendingInputUntil)
    ) {
      this.state = "idle";
      this.onStateChange(this.terminalId, this.spawnedAt, "idle");
    }
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  /**
   * Update polling interval dynamically (for tier changes like active → background).
   * Reschedules the interval without resetting state or boot detection.
   */
  setPollingInterval(intervalMs: number): void {
    // Short-circuit if interval unchanged
    if (this.POLLING_INTERVAL_MS === intervalMs) {
      return;
    }

    const wasPolling = this.pollingInterval !== undefined;
    this.POLLING_INTERVAL_MS = intervalMs;

    // If currently polling, reschedule without state reset
    if (wasPolling && this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = setInterval(() => this.runPollingCycle(), this.POLLING_INTERVAL_MS);
    }
  }
}

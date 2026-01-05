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
  private readonly MAX_NO_PROMPT_IDLE_MS: number;
  private readonly PROMPT_DEBOUNCE_MS = 200;
  private readonly WORKING_HOLD_MS = 400;
  private readonly SPINNER_ACTIVE_MS = 1500;
  private inBracketedPaste = false;
  private partialEscape = "";
  private pasteStartTime = 0;
  private readonly PASTE_TIMEOUT_MS = 5000;
  private readonly ignoredInputSequences: Set<string>;
  private pendingInputUntil = 0;
  private workingHoldUntil = 0;

  // Volume-based output detection
  private readonly outputDetectionEnabled: boolean;
  private readonly outputWindowMs: number;
  private readonly outputMinFrames: number;
  private readonly outputMinBytes: number;
  private outputWindowStart = 0;
  private outputFramesInWindow = 0;
  private outputBytesInWindow = 0;

  private readonly processStateValidator?: ProcessStateValidator;
  private lastActivityTimestamp = Date.now();
  private lastWorkingSignalAt = 0;
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

  // Boot detection patterns - when these appear, the agent is ready
  private static readonly BOOT_COMPLETE_PATTERNS = [
    /claude\s+code\s+v?\d/i, // Claude Code vX.X.X or Claude Code X.X.X
    /openai[-\s]+codex/i, // OpenAI Codex / OpenAI-Codex
    /codex\s+v/i, // Codex vX.X.X variant
    /type\s+your\s+message/i, // Gemini CLI ready prompt
  ];
  private static readonly DEFAULT_PROMPT_PATTERNS = [/^\s*[>›❯⟩]\s*/i];
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
    this.MAX_NO_PROMPT_IDLE_MS = options?.maxNoPromptIdleMs ?? 120000;

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

    let sawEnter = false;
    for (let i = 0; i < fullData.length; i++) {
      // Check for potential escape sequence start near end of buffer
      // This must be FIRST to properly handle partial sequences like Shift+Enter (\x1b\r)
      if (i >= fullData.length - 5 && fullData[i] === "\x1b") {
        // Save remaining characters as partial escape for next call
        this.partialEscape = fullData.substring(i);
        break;
      }

      // Check for Bracketed Paste Start: \x1b[200~
      if (fullData[i] === "\x1b" && fullData.substring(i, i + 6) === "\x1b[200~") {
        this.inBracketedPaste = true;
        this.pasteStartTime = Date.now();
        i += 5;
        continue;
      }

      // Check for Bracketed Paste End: \x1b[201~
      if (fullData[i] === "\x1b" && fullData.substring(i, i + 6) === "\x1b[201~") {
        this.inBracketedPaste = false;
        this.pasteStartTime = 0;
        i += 5;
        continue;
      }

      // Only trigger busy on Enter if we are NOT inside a paste
      const char = fullData[i];
      if ((char === "\r" || char === "\n") && !this.inBracketedPaste) {
        sawEnter = true;
        break;
      }
    }

    if (!sawEnter) {
      return;
    }

    const now = Date.now();
    if (!this.getVisibleLines) {
      this.becomeBusy({ trigger: "input" });
      return;
    }

    this.pendingInputUntil = now + this.INPUT_CONFIRM_MS;
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
      if (isWorking) {
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

    // Volume-based output detection (when enabled)
    if (!this.outputDetectionEnabled) {
      return;
    }

    const dataLength = Buffer.byteLength(data, "utf8");

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
   * Update the pattern buffer with new data, maintaining max size.
   */
  private updatePatternBuffer(data: string): void {
    this.patternBuffer += data;
    if (this.patternBuffer.length > this.PATTERN_BUFFER_SIZE) {
      this.patternBuffer = this.patternBuffer.slice(-this.PATTERN_BUFFER_SIZE);
    }
  }

  private recordWorkingSignal(now: number): void {
    this.lastWorkingSignalAt = now;
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
      this.becomeBusy({ trigger: "output" }, now);
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

  private detectPrompt(lines: string[], cursorLine?: string | null): PromptDetectionResult {
    const patterns = this.promptPatterns;
    if (patterns.length === 0) {
      return { isPrompt: false, confidence: 0 };
    }

    if (cursorLine) {
      const cleanCursor = stripAnsi(cursorLine);
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
    }

    const scanCount = Math.min(this.promptScanLineCount, lines.length);
    const scanLines = lines.slice(-scanCount);
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
      this.lastSpinnerDetectedAt > 0 &&
      now - this.lastSpinnerDetectedAt <= this.SPINNER_ACTIVE_MS
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
        const promptResult = this.detectPrompt(lines, cursorLine);
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
    this.recordWorkingSignal(now);
    this.resetDebounceTimer();

    if (this.state !== "busy") {
      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", metadata);
    }
  }

  private becomeBusyFromOutput(now: number): void {
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
    this.patternBuffer = "";
    this.lastPatternResult = undefined;
    this.pollingStartTime = 0;
    this.hasExitedBootState = false;
    this.pendingInputUntil = 0;
    this.workingHoldUntil = 0;
    this.lastWorkingSignalAt = 0;
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

    this.pollingInterval = setInterval(() => {
      const now = Date.now();

      const scanCount = Math.max(this.promptScanLineCount, 15);
      const lines = this.getVisibleLines!(scanCount);
      const cursorLine = this.getCursorLine?.() ?? null;
      const text = stripAnsi(lines.join(" ")).toLowerCase();

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

      if (isWorkingPattern) {
        this.recordWorkingSignal(now);
      }

      const promptResult = this.detectPrompt(lines, cursorLine);
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
      const isWorkingSignal = isWorkingPattern || isSpinnerActive || hasRecentOutputActivity;
      if (isWorkingSignal) {
        this.promptStableSince = 0;
      }

      if (this.pendingInputUntil > 0) {
        if (isWorkingSignal || isPrompt) {
          this.pendingInputUntil = 0;
        } else if (now >= this.pendingInputUntil) {
          this.pendingInputUntil = 0;
          this.becomeBusy({ trigger: "input" }, now);
          return;
        }
      }

      if (isWorkingSignal) {
        if (this.state !== "busy") {
          const metadata = isWorkingPattern
            ? { trigger: "pattern" as const, patternConfidence: patternResult?.confidence ?? 0.9 }
            : { trigger: "output" as const };
          this.becomeBusy(metadata, now);
        }
        return;
      }

      if (isPrompt && this.state === "busy" && now >= this.workingHoldUntil) {
        if (now - this.promptStableSince >= this.PROMPT_DEBOUNCE_MS) {
          this.state = "idle";
          this.onStateChange(this.terminalId, this.spawnedAt, "idle");
        }
        return;
      }

      if (
        this.state === "busy" &&
        !isPrompt &&
        now >= this.workingHoldUntil &&
        !(this.pendingInputUntil > 0 && now < this.pendingInputUntil)
      ) {
        const sinceWorking = now - this.lastWorkingSignalAt;
        if (this.lastWorkingSignalAt > 0 && sinceWorking >= this.MAX_NO_PROMPT_IDLE_MS) {
          this.state = "idle";
          this.onStateChange(this.terminalId, this.spawnedAt, "idle");
        }
      }
    }, 50); // Poll at 50ms for responsive state detection
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }
}

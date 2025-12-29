import {
  AgentPatternDetector,
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
   * Size of the output buffer to retain for pattern detection (default: 2000 chars).
   */
  patternBufferSize?: number;
  /**
   * Callback to get the last N lines from xterm (already ANSI-cleaned).
   * If provided, polling uses this instead of raw buffer.
   */
  getVisibleLines?: (n: number) => string[];
}

export interface ActivityStateMetadata {
  trigger: "input" | "output" | "pattern";
  /**
   * Confidence level when trigger is "pattern" (0-1).
   */
  patternConfidence?: number;
}

export class ActivityMonitor {
  private state: "busy" | "idle" = "idle";
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 2500;
  private inBracketedPaste = false;
  private partialEscape = "";
  private pasteStartTime = 0;
  private readonly PASTE_TIMEOUT_MS = 5000;
  private readonly ignoredInputSequences: Set<string>;

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
  private readonly SLEEP_DETECTION_THRESHOLD_MS = 5000;
  private pendingStateRevalidation = false;

  // Pattern-based detection
  private readonly patternDetector?: AgentPatternDetector;
  private patternBuffer = "";
  private readonly PATTERN_BUFFER_SIZE: number;
  private lastPatternResult?: PatternDetectionResult;
  private readonly getVisibleLines?: (n: number) => string[];
  private pollingInterval?: ReturnType<typeof setInterval>;

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
  }

  /**
   * Called when user sends input to the terminal.
   * Proactively transitions to BUSY on Enter key, but ignores pastes.
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
        this.becomeBusy();
        // Once busy is triggered, we don't need to keep checking this chunk
        break;
      }
    }
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

    if (this.state === "busy") {
      this.resetDebounceTimer();
      return;
    }

    if (!data) {
      return;
    }

    // Skip old pattern detection if polling is enabled - polling is the sole source of truth
    if (this.getVisibleLines) {
      return;
    }

    // Legacy: Update pattern buffer and check for working patterns (non-polling terminals only)
    if (this.patternDetector) {
      this.updatePatternBuffer(data);
      const patternResult = this.patternDetector.detect(this.patternBuffer);
      this.lastPatternResult = patternResult;

      if (patternResult.isWorking) {
        // Pattern detected - transition to busy with high confidence
        this.becomeBusyFromPattern(patternResult.confidence);
        return;
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
      this.becomeBusyFromOutput();
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

  /**
   * Transition to busy state based on pattern detection.
   */
  private becomeBusyFromPattern(confidence: number): void {
    this.resetDebounceTimer();

    if (this.state !== "busy") {
      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", {
        trigger: "pattern",
        patternConfidence: confidence,
      });
    }
  }

  private revalidateStateAfterWake(): void {
    const actuallyBusy = this.hasActiveChildrenSafe();
    if (actuallyBusy === null) {
      return;
    }
    if (!actuallyBusy && this.state === "busy") {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.state = "idle";
      this.onStateChange(this.terminalId, this.spawnedAt, "idle");
    }
  }

  private becomeBusy(): void {
    this.resetDebounceTimer();

    if (this.state !== "busy") {
      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", { trigger: "input" });
    }
  }

  private becomeBusyFromOutput(): void {
    if (this.state !== "busy") {
      // Validate CPU activity before entering busy state from output detection.
      // This prevents character echoes during typing from triggering active state.
      // null = no validator available, allow transition (fail open for compatibility)
      // true = CPU activity detected, allow transition
      // false = no CPU activity, user is typing, deny transition
      const actuallyBusy = this.hasActiveChildrenSafe();
      if (actuallyBusy === false) {
        return;
      }

      this.state = "busy";
      this.onStateChange(this.terminalId, this.spawnedAt, "busy", {
        trigger: "output",
      });
    }

    this.resetDebounceTimer();
  }

  private resetDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      // Polling terminals: just transition to idle - polling is sole source of truth
      if (this.getVisibleLines) {
        this.state = "idle";
        this.onStateChange(this.terminalId, this.spawnedAt, "idle");
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
    }, this.DEBOUNCE_MS);
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
   * Start polling for patterns in xterm visible lines.
   * Dead simple: pattern found → working, pattern not found → waiting.
   */
  startPolling(): void {
    if (!this.getVisibleLines || this.pollingInterval) return;

    this.pollingInterval = setInterval(() => {
      const lines = this.getVisibleLines!(3);
      const text = lines.join(" ").toLowerCase();
      const isWorking = text.includes("esc to interrupt") || text.includes("esc to cancel");

      if (isWorking && this.state !== "busy") {
        this.state = "busy";
        this.onStateChange(this.terminalId, this.spawnedAt, "busy", { trigger: "pattern" });
      } else if (!isWorking && this.state === "busy") {
        this.state = "idle";
        this.onStateChange(this.terminalId, this.spawnedAt, "idle");
      }
    }, 100);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }
}

export interface ProcessStateValidator {
  hasActiveChildren(): boolean;
}

export interface ActivityMonitorOptions {
  ignoredInputSequences?: string[];
  processStateValidator?: ProcessStateValidator;
}

export interface ActivityStateMetadata {
  trigger: "input" | "output";
}

export class ActivityMonitor {
  private state: "busy" | "idle" = "idle";
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 1500;
  private inBracketedPaste = false;
  private partialEscape = "";
  private pasteStartTime = 0;
  private readonly PASTE_TIMEOUT_MS = 5000;
  private readonly ignoredInputSequences: Set<string>;

  private readonly processStateValidator?: ProcessStateValidator;
  private lastActivityTimestamp = Date.now();
  private readonly SLEEP_DETECTION_THRESHOLD_MS = 5000;
  private pendingStateRevalidation = false;

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

      // Check for potential escape sequence start near end of buffer
      // Only buffer if we haven't found Enter yet (avoid blocking Enter detection)
      if (i >= fullData.length - 5 && fullData[i] === "\x1b") {
        // Save remaining characters as partial escape for next call
        this.partialEscape = fullData.substring(i);
        break;
      }
    }
  }

  /**
   * Called on every data event from PTY (output received).
   *
   * Key behaviors:
   * 1. If already busy, any output resets the debounce timer (keeps us busy)
   * 2. If idle, output with CPU activity transitions to busy (agent resumed)
   * 3. System sleep/wake detection prevents stale state after laptop sleep
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

    if (!data) {
      return;
    }

    if (this.state === "busy") {
      this.resetDebounceTimer();
      return;
    }

    this.becomeBusyFromOutput();
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.inBracketedPaste = false;
    this.partialEscape = "";
    this.pasteStartTime = 0;
  }

  getState(): "busy" | "idle" {
    return this.state;
  }
}

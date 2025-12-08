export class ActivityMonitor {
  private state: "busy" | "idle" = "idle";
  private debounceTimer: NodeJS.Timeout | null = null;
  // 1.5 seconds silence required to consider the agent "waiting"
  private readonly DEBOUNCE_MS = 1500;
  private inBracketedPaste = false;
  private partialEscape = "";
  private pasteStartTime = 0;
  private readonly PASTE_TIMEOUT_MS = 5000;

  constructor(
    private terminalId: string,
    private onStateChange: (id: string, state: "busy" | "idle") => void
  ) {}

  /**
   * Called when user sends input to the terminal.
   * Proactively transitions to BUSY on Enter key, but ignores pastes.
   */
  onInput(data: string): void {
    // Ignore Shift+Enter sequence (\x1b\r) sent by XtermAdapter for soft line breaks.
    if (data === "\x1b\r") {
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

    // Iterate through the data character by character to track state
    for (let i = 0; i < fullData.length; i++) {
      // Check for potential escape sequence start near end of buffer
      if (i >= fullData.length - 5 && fullData[i] === "\x1b") {
        // Save remaining characters as partial escape for next call
        this.partialEscape = fullData.substring(i);
        break;
      }

      // Check for Bracketed Paste Start: \x1b[200~
      if (fullData[i] === "\x1b" && fullData.substring(i, i + 6) === "\x1b[200~") {
        this.inBracketedPaste = true;
        this.pasteStartTime = Date.now();
        i += 5; // Skip the sequence
        continue;
      }

      // Check for Bracketed Paste End: \x1b[201~
      if (fullData[i] === "\x1b" && fullData.substring(i, i + 6) === "\x1b[201~") {
        this.inBracketedPaste = false;
        this.pasteStartTime = 0;
        i += 5; // Skip the sequence
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
   * Only extends the BUSY state; never triggers it.
   */
  onData(): void {
    // If we are already busy, any output resets the "silence" timer.
    // If we are idle, we ignore output (background noise).
    if (this.state === "busy") {
      this.resetDebounceTimer();
    }
  }

  private becomeBusy(): void {
    // Always reset the timer when activity happens
    this.resetDebounceTimer();

    // Only fire state change if we weren't already busy
    if (this.state !== "busy") {
      this.state = "busy";
      this.onStateChange(this.terminalId, "busy");
    }
  }

  private resetDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.state = "idle";
      this.onStateChange(this.terminalId, "idle");
      this.debounceTimer = null;
    }, this.DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.inBracketedPaste = false;
    this.partialEscape = "";
    this.pasteStartTime = 0;
  }

  getState(): "busy" | "idle" {
    return this.state;
  }
}

export interface InputTrackerConfig {
  ignoredInputSequences?: string[];
  pasteTimeoutMs?: number;
  inputConfirmMs?: number;
  echoWindowMs?: number;
  echoMaxBytes?: number;
}

export type InputResult =
  | { kind: "ignored" }
  | { kind: "no-enter" }
  | { kind: "enter"; hadText: boolean };

export class InputTracker {
  private inBracketedPaste = false;
  private partialEscape = "";
  private pasteStartTime = 0;
  private pendingInputChars = 0;
  lastUserInputAt = 0;
  pendingInputUntil = 0;
  pendingInputWasNonEmpty = false;

  private readonly ignoredInputSequences: Set<string>;
  private readonly PASTE_TIMEOUT_MS: number;
  readonly INPUT_CONFIRM_MS: number;
  readonly INPUT_ECHO_WINDOW_MS: number;
  readonly ECHO_MAX_BYTES: number;

  constructor(config?: InputTrackerConfig) {
    this.ignoredInputSequences = new Set(config?.ignoredInputSequences ?? ["\x1b\r"]);
    this.PASTE_TIMEOUT_MS = config?.pasteTimeoutMs ?? 5000;
    this.INPUT_CONFIRM_MS = config?.inputConfirmMs ?? 1000;
    this.INPUT_ECHO_WINDOW_MS = config?.echoWindowMs ?? 1000;
    this.ECHO_MAX_BYTES = config?.echoMaxBytes ?? 24;
  }

  process(data: string, now: number): InputResult {
    if (this.ignoredInputSequences.has(data)) {
      return { kind: "ignored" };
    }

    this.lastUserInputAt = now;

    // Fail-safe: exit paste mode if it has been open too long
    if (
      this.inBracketedPaste &&
      this.pasteStartTime > 0 &&
      now - this.pasteStartTime > this.PASTE_TIMEOUT_MS
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
      return { kind: "ignored" };
    }

    if (this.ignoredInputSequences.has(scanData)) {
      return { kind: "ignored" };
    }

    let sawEnter = false;
    let inputHadText = false;
    for (let i = 0; i < scanData.length; i++) {
      if (scanData[i] === "\x1b" && scanData.substring(i, i + 6) === "\x1b[200~") {
        this.inBracketedPaste = true;
        this.pasteStartTime = now;
        this.pendingInputChars = Math.max(this.pendingInputChars, 1);
        i += 5;
        continue;
      }

      if (scanData[i] === "\x1b" && scanData.substring(i, i + 6) === "\x1b[201~") {
        this.inBracketedPaste = false;
        this.pasteStartTime = 0;
        i += 5;
        continue;
      }

      if (scanData[i] === "\x1b") {
        const escapeEnd = InputTracker.findEscapeSequenceEnd(scanData.slice(i));
        if (escapeEnd !== null) {
          i += escapeEnd - 1;
          continue;
        }
      }

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
      return { kind: "no-enter" };
    }

    this.pendingInputChars = 0;
    return { kind: "enter", hadText: inputHadText };
  }

  isRecentUserInput(now: number): boolean {
    return this.lastUserInputAt > 0 && now - this.lastUserInputAt < this.INPUT_ECHO_WINDOW_MS;
  }

  isLikelyUserEcho(data: string, now: number): boolean {
    if (!this.isRecentUserInput(now)) {
      return false;
    }

    if (this.pendingInputUntil > 0) {
      return false;
    }

    if (data.includes("\x1b") || data.includes("\r") || data.includes("\n")) {
      return false;
    }

    if (Buffer.byteLength(data, "utf8") > this.ECHO_MAX_BYTES) {
      return false;
    }

    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (
        (code >= 0x00 && code <= 0x07) ||
        (code >= 0x0b && code <= 0x1a) ||
        (code >= 0x1c && code <= 0x1f)
      ) {
        return false;
      }
    }

    return true;
  }

  clearPendingInput(): void {
    this.pendingInputUntil = 0;
    this.pendingInputWasNonEmpty = false;
  }

  reset(): void {
    this.inBracketedPaste = false;
    this.partialEscape = "";
    this.pasteStartTime = 0;
    this.pendingInputChars = 0;
    this.lastUserInputAt = 0;
    this.pendingInputUntil = 0;
    this.pendingInputWasNonEmpty = false;
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
    const escapeEnd = InputTracker.findEscapeSequenceEnd(trailing);
    if (escapeEnd !== null) {
      return { scanData: data, partialEscape: "" };
    }

    return {
      scanData: data.slice(0, escIndex),
      partialEscape: trailing,
    };
  }

  static findEscapeSequenceEnd(sequence: string): number | null {
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
}

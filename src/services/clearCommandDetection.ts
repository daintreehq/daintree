// Commands that trigger visual terminal clear (AI agents + standard shell)
export const CLEAR_COMMANDS = new Set(["/clear", "/new", "/reset", "clear", "cls"]);

export interface InputResult {
  isClear: boolean;
  command: string | null;
}

/**
 * Tracks user input keystrokes to detect clear commands before Enter.
 * Handles multi-char chunks (paste), backspace, control characters, and escape sequences.
 */
export class InputTracker {
  private buffer = "";
  private inBracketedPaste = false;
  private results: InputResult[] = [];

  process(data: string): InputResult[] {
    this.results = [];

    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      const code = char.charCodeAt(0);

      // Handle bracketed paste start: ESC[200~
      if (char === "\x1b" && data.substring(i, i + 6) === "\x1b[200~") {
        this.inBracketedPaste = true;
        i += 5;
        continue;
      }

      // Handle bracketed paste end: ESC[201~
      if (char === "\x1b" && data.substring(i, i + 6) === "\x1b[201~") {
        this.inBracketedPaste = false;
        i += 5;
        continue;
      }

      // Ignore newlines inside bracketed paste (multi-line paste should not trigger commands)
      if (this.inBracketedPaste && (char === "\r" || char === "\n")) {
        this.buffer += char;
        continue;
      }

      // Handle Enter (CR or LF) - processing point
      if (char === "\r" || char === "\n") {
        const cmd = this.buffer.trim();
        this.buffer = "";

        if (cmd) {
          this.results.push({
            isClear: CLEAR_COMMANDS.has(cmd),
            command: cmd,
          });
        }
        continue;
      }

      // Handle Backspace (DEL - 0x7f or BS - 0x08)
      if (char === "\x7f" || char === "\b") {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }

      // Handle escape sequences (arrows, home/end) -> Reset buffer and skip sequence
      if (char === "\x1b" && !this.inBracketedPaste) {
        this.buffer = "";
        // Skip the rest of the escape sequence (commonly ESC[A, ESC[B, etc.)
        // Look ahead for common patterns and skip them
        if (i + 1 < data.length && data[i + 1] === "[") {
          i++; // Skip '['
          // Skip until we find a letter (command terminator)
          while (i + 1 < data.length && !/[A-Za-z]/.test(data[i + 1])) {
            i++;
          }
          if (i + 1 < data.length) {
            i++; // Skip the letter
          }
        }
        continue;
      }

      // Handle other control characters (Ctrl+C, Ctrl+D, etc) -> Reset buffer
      if (code < 32) {
        this.buffer = "";
        continue;
      }

      // Accumulate printable characters
      this.buffer += char;
    }

    return this.results;
  }

  reset(): void {
    this.buffer = "";
    this.inBracketedPaste = false;
    this.results = [];
  }
}

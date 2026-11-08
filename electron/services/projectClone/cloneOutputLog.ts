import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";

const MAX_LINES = 100;
const MAX_LINE_CHARS = 400;

/**
 * Git's stderr as a terminal would show it, last lines only. Git redraws its
 * progress line in place with a bare `\r`, so a carriage return starts the
 * line over rather than adding one: "Receiving objects: 64%" replaces 63%
 * instead of piling up a line per percent. Chunks split anywhere, including
 * between a `\r` and its `\n`.
 *
 * Every line is scrubbed of credentials before it is kept: an authenticated
 * clone URL embeds a token, and git echoes its remote in some errors.
 */
export class CloneOutputLog {
  private readonly lines: string[] = [];
  private current = "";
  /** A `\r` ended the last chunk: a `\n` next completes it, anything else redraws. */
  private pendingCarriageReturn = false;

  append(chunk: string): void {
    for (const char of chunk) {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false;
        if (char === "\n") {
          this.commit();
          continue;
        }
        this.current = "";
      }
      if (char === "\n") {
        this.commit();
      } else if (char === "\r") {
        this.pendingCarriageReturn = true;
      } else if (this.current.length < MAX_LINE_CHARS) {
        this.current += char;
      }
    }
  }

  /** A whole line from somewhere other than git's stream, such as a provider's progress. */
  appendLine(line: string): void {
    if (this.current.length > 0) this.commit();
    this.current = line.slice(0, MAX_LINE_CHARS);
    this.commit();
  }

  /** Replace the line being drawn, as git's own progress redraw does. */
  redrawLine(line: string): void {
    this.current = line.slice(0, MAX_LINE_CHARS);
    this.pendingCarriageReturn = false;
  }

  snapshot(): string[] {
    const current = this.current.trimEnd();
    return current.length > 0 ? [...this.lines, scrubSecrets(current)] : [...this.lines];
  }

  private commit(): void {
    const line = this.current.trimEnd();
    this.current = "";
    if (line.length === 0) return;
    this.lines.push(scrubSecrets(line));
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }
}

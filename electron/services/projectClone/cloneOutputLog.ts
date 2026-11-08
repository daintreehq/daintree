import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";

const MAX_LINES = 100;
/** What a kept line shows, cut only after it has been scrubbed whole. */
const MAX_LINE_CHARS = 400;
/** What one line may grow to before it is ended, so a stream with no breaks stays bounded. */
const MAX_RAW_LINE_CHARS = 16_384;

/**
 * A URL's credentials cut off before the `@` that lets the scrubber see them,
 * as at the end of a line ended for its length.
 */
const TRAILING_URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+$/i;

function displayLine(raw: string): string {
  const scrubbed = scrubSecrets(raw.trimEnd()).replace(TRAILING_URL_CREDENTIALS, "$1[redacted]");
  return scrubbed.length > MAX_LINE_CHARS ? `${scrubbed.slice(0, MAX_LINE_CHARS - 1)}…` : scrubbed;
}

/**
 * Git's stderr as a terminal would show it, last lines only. Git redraws its
 * progress line in place with a bare `\r`, so a carriage return replaces the
 * line on show rather than adding one: "Receiving objects: 64%" replaces 63%
 * instead of piling up a line per percent. Chunks split anywhere, including
 * between a `\r` and its `\n`.
 *
 * Only whole lines are shown, each scrubbed of credentials before it is cut to
 * length: an authenticated clone URL embeds a token, git echoes its remote in
 * some errors, and a line still arriving could stop just short of the `@` the
 * scrubber needs to recognise one.
 */
export class CloneOutputLog {
  private readonly lines: string[] = [];
  /** The last line git ended with `\r`: on show until git redraws or ends it. */
  private live: string | null = null;
  /** The line still arriving. Never shown. */
  private current = "";
  /** A `\r` ended the last chunk: a `\n` next turns the redraw into a line. */
  private pendingCarriageReturn = false;
  /**
   * The line outgrew {@link MAX_RAW_LINE_CHARS}: the rest of it is dropped up
   * to its real end, since a fragment shown on its own could carry the second
   * half of a credential with nothing left to recognise it by.
   */
  private overflowed = false;

  append(chunk: string): void {
    for (const char of chunk) {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false;
        if (char === "\n") {
          this.commitLive();
          continue;
        }
      }
      if (char === "\n") {
        this.commitCurrent();
      } else if (char === "\r") {
        this.pendingCarriageReturn = true;
        if (this.current.trim().length > 0) this.live = displayLine(this.current);
        this.current = "";
        this.overflowed = false;
      } else if (!this.overflowed) {
        this.current += char;
        if (this.current.length >= MAX_RAW_LINE_CHARS) this.overflowed = true;
      }
    }
  }

  /**
   * Start a line from somewhere other than git's stream, such as a provider's
   * progress. It stays on show as the line being redrawn, so
   * {@link redrawLine} updates it.
   */
  appendLine(line: string): void {
    this.commitLive();
    this.live = displayLine(line);
  }

  /** Replace the line being redrawn, as git's own progress redraw does. */
  redrawLine(line: string): void {
    this.live = displayLine(line);
  }

  snapshot(): string[] {
    return this.live !== null ? [...this.lines, this.live] : [...this.lines];
  }

  private push(line: string): void {
    if (line.length === 0) return;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  private commitLive(): void {
    if (this.live !== null) this.push(this.live);
    this.live = null;
  }

  /** A line ended with `\n` replaces whatever progress line was on show. */
  private commitCurrent(): void {
    const raw = this.current;
    this.current = "";
    this.overflowed = false;
    this.live = null;
    if (raw.trim().length > 0) this.push(displayLine(raw));
  }
}

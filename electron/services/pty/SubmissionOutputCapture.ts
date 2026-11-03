import type { IBuffer, IDisposable, IMarker, Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  SUBMISSION_OUTPUT_MAX_BYTES,
  SUBMISSION_OUTPUT_MAX_LINES,
  type TerminalSubmissionOutput,
} from "../../../shared/types/terminalSubmission.js";

/**
 * Collects what a terminal rendered after one submission's Enter (#16210), so
 * the sender can read its answer once the agent has printed past it.
 *
 * The source is the mirror's rendered rows, never the raw stream: an agent TUI
 * paints by cursor addressing, and stripping escapes from that leaves
 * fragments and every spinner frame. Rows are read as they leave the viewport
 * into scrollback, which is the point an inline TUI (Codex, Claude Code) stops
 * repainting them, so the capture holds what was finally shown and no longer
 * depends on how much scrollback the mirror keeps. Rows still on screen are
 * read live and only kept once the capture closes.
 *
 * Two kinds of row reach scrollback without being output after the write:
 *
 * - The rows above the cursor when the Enter was written. They are matched by
 *   text as they scroll off and dropped; the first row that matches none of
 *   them ends the skipping for good.
 * - A replay. Codex purges scrollback (`CSI 3 J`) on a resize and re-emits its
 *   whole transcript reflowed to the new width, so the old history scrolls off
 *   again. After a purge, scrolled-off rows are searched for the tail of what
 *   was captured (or of the submitted text, when nothing was yet), compared
 *   with whitespace collapsed so a reflow's new line breaks still match. Rows
 *   after the latest match are the continuation. A purge that never lines back
 *   up leaves the capture `lost`, keeping the text from before it.
 *
 * Bounded at {@link SUBMISSION_OUTPUT_MAX_LINES} lines and
 * {@link SUBMISSION_OUTPUT_MAX_BYTES} bytes, keeping the start: a goal-mode
 * agent may never settle, so the cap is what ends a capture, and past it the
 * capture does no further work.
 */

interface Row {
  text: string;
  /** Soft-wrapped continuation of the row before it. */
  wrapped: boolean;
}

/** Normalized characters of the replay anchor; long enough to be unique, short enough to survive a reflow. */
const ANCHOR_MAX_CHARS = 512;

/** Below this, the captured text is too little to find again, and the submitted text anchors instead. */
const ANCHOR_MIN_CHARS = 24;

const WHITESPACE = /\s/;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Collapse whitespace runs to one space, the way the replay stream is fed. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function rowsToLines(rows: readonly Row[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) {
      lines[lines.length - 1] += row.text;
    } else {
      lines.push(row.text);
    }
  }
  // Trimmed per line, not per row: a soft wrap can end a row on the space
  // between two words.
  return lines.map((line) => line.trimEnd());
}

function rowsToStream(rows: readonly Row[]): string {
  let stream = "";
  for (const row of rows) stream += (row.wrapped ? "" : " ") + row.text;
  return normalize(stream);
}

function readRow(buffer: IBuffer, line: number): Row | undefined {
  const bufferLine = buffer.getLine(line);
  if (bufferLine === undefined) return undefined;
  return { text: bufferLine.translateToString(true), wrapped: bufferLine.isWrapped };
}

/** Knuth-Morris-Pratt over the normalized stream, so a replay is searched once, row by row. */
class AnchorMatcher {
  private readonly failure: Int32Array;
  private matched = 0;
  private lastWasSpace = true;

  constructor(private readonly anchor: string) {
    this.failure = new Int32Array(anchor.length);
    let k = 0;
    for (let i = 1; i < anchor.length; i += 1) {
      while (k > 0 && anchor[i] !== anchor[k]) k = this.failure[k - 1]!;
      if (anchor[i] === anchor[k]) k += 1;
      this.failure[i] = k;
    }
  }

  clone(): AnchorMatcher {
    const copy = new AnchorMatcher(this.anchor);
    copy.matched = this.matched;
    copy.lastWasSpace = this.lastWasSpace;
    return copy;
  }

  /**
   * Feed one row. Returns the index in `row.text` just past the latest
   * complete match inside it, or -1. A match can span rows.
   */
  feed(row: Row): number {
    let end = -1;
    if (!row.wrapped && this.step(" ")) end = 0;
    for (let index = 0; index < row.text.length; index += 1) {
      if (this.step(row.text[index]!)) end = index + 1;
    }
    return end;
  }

  private step(raw: string): boolean {
    let char = raw;
    if (WHITESPACE.test(raw)) {
      if (this.lastWasSpace) return false;
      this.lastWasSpace = true;
      char = " ";
    } else {
      this.lastWasSpace = false;
    }
    const anchor = this.anchor;
    while (this.matched > 0 && char !== anchor[this.matched]) {
      this.matched = this.failure[this.matched - 1]!;
    }
    if (char === anchor[this.matched]) this.matched += 1;
    if (this.matched === anchor.length) {
      this.matched = this.failure[this.matched - 1]!;
      return true;
    }
    return false;
  }
}

/** Rows that were on screen above the cursor at the write, dropped as they scroll off. */
class PreWriteSkip {
  private next = 0;

  private readonly rows: readonly string[];

  constructor(rows: readonly string[]) {
    this.rows = rows.map((row) => row.trimEnd());
  }

  clone(): PreWriteSkip {
    const copy = new PreWriteSkip(this.rows);
    copy.next = this.next;
    return copy;
  }

  /** True when `text` is one of the pre-write rows still to scroll off. */
  skips(raw: string): boolean {
    const text = raw.trimEnd();
    if (text === "") return true;
    for (let index = this.next; index < this.rows.length; index += 1) {
      if (this.rows[index] === text) {
        this.next = index + 1;
        return true;
      }
    }
    return false;
  }

  get exhausted(): boolean {
    return this.next >= this.rows.length;
  }
}

interface Replay {
  matcher: AnchorMatcher;
  /** Captured rows kept before the purge; a later match cuts back to them. */
  keptRows: number;
  aligned: boolean;
}

export class SubmissionOutputCapture {
  private readonly rows: Row[] = [];
  private lines = 0;
  private bytes = 0;
  /**
   * The last row read, once one is in scrollback. A marker rather than an
   * index because scrollback trims shift every index; and on a scrolled-off
   * row rather than the first unread one, because xterm clears the markers on
   * any screen row it erases, and only a trim or a purge reaches scrollback.
   */
  private marker: IMarker | undefined;
  /** The next row to read while no marker is held: before anything is in scrollback, and after a purge. */
  private unmarkedNext = 0;
  /** A purge was seen, so the marker it deletes is expected to be gone. */
  private purged = false;
  private skip: PreWriteSkip | undefined;
  private replay: Replay | undefined;
  private purgeHandler: IDisposable | undefined;
  private state: TerminalSubmissionOutput["state"] = "capturing";
  private truncated = false;

  constructor(
    private readonly terminal: HeadlessTerminal,
    private readonly submittedText: string
  ) {
    const buffer = terminal.buffer.active;
    if (buffer.type === "normal") {
      const above: string[] = [];
      for (let y = 0; y < buffer.cursorY; y += 1) {
        const row = readRow(buffer, buffer.baseY + y);
        if (row !== undefined) above.push(row.text);
      }
      if (above.some((text) => text.trim() !== "")) this.skip = new PreWriteSkip(above);
      this.markReadUpTo(buffer.baseY);
    }
    // Runs before xterm's own handler, so rows that scrolled off since the
    // last sync are read before the purge deletes them.
    this.purgeHandler = terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === 3) this.notePurge();
      return false;
    });
  }

  get isOpen(): boolean {
    return this.state === "capturing";
  }

  /** Read the rows that scrolled off since the last call. Call after each parse. */
  sync(): void {
    if (this.state !== "capturing") return;
    const buffer = this.terminal.buffer.active;
    // The alternate screen has no scrollback; the normal buffer is untouched
    // while it shows, and its rows are read once it is back.
    if (buffer.type !== "normal") return;
    const from = this.nextUnread();
    // Rows scrolled out of the mirror's scrollback before they were read.
    if (from === undefined) return this.finish("lost");
    const to = buffer.baseY;
    if (to <= from) return;
    for (let line = from; line < to && this.state === "capturing"; line += 1) {
      const row = readRow(buffer, line);
      if (row !== undefined) this.take(row);
    }
    if (this.state === "capturing") this.markReadUpTo(to);
  }

  /** What has been captured, with the rows still on screen read live. */
  snapshot(): TerminalSubmissionOutput {
    if (this.state !== "capturing") return this.render(this.rows);
    const live = this.readLive();
    const kept = live.cutTo === undefined ? this.rows : this.rows.slice(0, live.cutTo);
    return this.render([...kept, ...live.rows]);
  }

  /** End the capture, keeping the rows still on screen, and return its final form. */
  close(): TerminalSubmissionOutput {
    if (this.state === "capturing") {
      this.sync();
      if (this.state === "capturing") {
        const live = this.readLive();
        if (!live.aligned) {
          this.finish("lost");
        } else {
          if (live.cutTo !== undefined) this.truncateTo(live.cutTo);
          for (const row of live.rows) {
            this.append(row);
            if (this.state !== "capturing") break;
          }
          if (this.state === "capturing") this.finish("closed");
        }
      }
    }
    return this.render(this.rows);
  }

  dispose(): void {
    if (this.state === "capturing") this.finish("closed");
    this.release();
  }

  /** The first normal-buffer row not yet read, or undefined when rows were lost before it. */
  private nextUnread(): number | undefined {
    const marker = this.marker;
    if (marker !== undefined) {
      if (!marker.isDisposed) return marker.line + 1;
      if (!this.purged) return undefined;
      // The purge deleted all scrollback, so every row there now came after it.
      this.marker = undefined;
      this.unmarkedNext = 0;
    }
    this.purged = false;
    // Without a marker nothing tracks a trim, and trimming starts only once
    // scrollback is full, so up to that point the index still holds.
    const buffer = this.terminal.buffer.normal;
    const scrollback = this.terminal.options.scrollback ?? 0;
    if (buffer.baseY > this.unmarkedNext && buffer.baseY >= scrollback) return undefined;
    return this.unmarkedNext;
  }

  /** {@link nextUnread} without settling a purge, for a read that must not change state. */
  private nextUnreadPeek(): number | undefined {
    const marker = this.marker;
    if (marker === undefined) return this.unmarkedNext;
    if (!marker.isDisposed) return marker.line + 1;
    return this.purged ? 0 : undefined;
  }

  /** Note every row above `line` as read. */
  private markReadUpTo(line: number): void {
    this.marker?.dispose();
    this.marker = undefined;
    this.unmarkedNext = line;
    if (line === 0) return;
    const buffer = this.terminal.buffer.normal;
    this.marker = this.terminal.registerMarker(line - 1 - (buffer.baseY + buffer.cursorY));
  }

  private notePurge(): void {
    if (this.state !== "capturing") return;
    this.sync();
    if (this.state !== "capturing") return;
    this.purged = true;
    const captured = rowsToStream(this.rows);
    const source = captured.length >= ANCHOR_MIN_CHARS ? captured : normalize(this.submittedText);
    const anchor = source.slice(-ANCHOR_MAX_CHARS).trimStart();
    this.skip = undefined;
    if (anchor.length === 0) return this.finish("lost");
    this.replay = { matcher: new AnchorMatcher(anchor), keptRows: this.rows.length, aligned: false };
  }

  private take(row: Row): void {
    const replay = this.replay;
    if (replay !== undefined) {
      const end = replay.matcher.feed(row);
      if (end >= 0) {
        this.truncateTo(replay.keptRows);
        replay.aligned = true;
        const rest = row.text.slice(end);
        if (rest.trim() !== "") this.append({ text: rest.trimStart(), wrapped: false });
        return;
      }
      if (!replay.aligned) return;
    } else if (this.skip !== undefined) {
      if (this.skip.skips(row.text)) {
        if (this.skip.exhausted) this.skip = undefined;
        return;
      }
      this.skip = undefined;
    }
    this.append(row);
  }

  private append(row: Row): void {
    const joins = row.wrapped && this.rows.length > 0;
    const bytes = utf8Bytes(row.text) + (joins || this.rows.length === 0 ? 0 : 1);
    if (!joins && this.lines >= SUBMISSION_OUTPUT_MAX_LINES) return this.cap();
    if (this.bytes + bytes > SUBMISSION_OUTPUT_MAX_BYTES) return this.cap();
    this.rows.push(row);
    this.bytes += bytes;
    if (!joins) this.lines += 1;
  }

  private truncateTo(count: number): void {
    if (this.rows.length === count) return;
    this.rows.length = count;
    const lines = rowsToLines(this.rows);
    this.lines = lines.length;
    this.bytes = utf8Bytes(lines.join("\n"));
  }

  private cap(): void {
    this.truncated = true;
    this.finish("closed");
  }

  /**
   * On-screen rows below what has been read, through copies of the skip and
   * replay state. A replay match on screen supersedes any continuation read
   * before it, so `cutTo` says how many captured rows it leaves standing.
   */
  private readLive(): { rows: Row[]; cutTo?: number; aligned: boolean } {
    const buffer = this.terminal.buffer.active;
    const next = buffer.type === "normal" ? this.nextUnreadPeek() : undefined;
    const top = next === undefined ? buffer.baseY : Math.max(next, buffer.baseY);
    const replay = this.replay;
    const skip = replay === undefined ? this.skip?.clone() : undefined;
    const matcher = replay?.matcher.clone();
    let aligned = replay?.aligned ?? true;
    let cutTo: number | undefined;
    let rows: Row[] = [];
    for (let line = top; line < buffer.baseY + this.terminal.rows; line += 1) {
      const row = readRow(buffer, line);
      if (row === undefined) continue;
      if (matcher !== undefined && replay !== undefined) {
        const end = matcher.feed(row);
        if (end >= 0) {
          aligned = true;
          cutTo = replay.keptRows;
          rows = [];
          const rest = row.text.slice(end);
          if (rest.trim() !== "") rows.push({ text: rest.trimStart(), wrapped: false });
          continue;
        }
        if (!aligned) continue;
      } else if (skip !== undefined && !skip.exhausted) {
        if (skip.skips(row.text)) continue;
      }
      rows.push(row);
    }
    while (rows.length > 0 && rows[rows.length - 1]!.text.trim() === "") rows.pop();
    return { rows, aligned, ...(cutTo !== undefined ? { cutTo } : {}) };
  }

  private render(rows: readonly Row[]): TerminalSubmissionOutput {
    let truncated = this.truncated;
    const lines = rowsToLines(rows);
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length > SUBMISSION_OUTPUT_MAX_LINES) {
      lines.length = SUBMISSION_OUTPUT_MAX_LINES;
      truncated = true;
    }
    let text = lines.join("\n");
    if (utf8Bytes(text) > SUBMISSION_OUTPUT_MAX_BYTES) {
      text = cutToBytes(text, SUBMISSION_OUTPUT_MAX_BYTES);
      truncated = true;
    }
    return { text, truncated, state: this.state };
  }

  private finish(state: "closed" | "lost"): void {
    this.state = state;
    this.release();
  }

  private release(): void {
    this.marker?.dispose();
    this.marker = undefined;
    this.purgeHandler?.dispose();
    this.purgeHandler = undefined;
    this.replay = undefined;
    this.skip = undefined;
  }
}

/** Receives a capture's output as it grows, and once more, final, when it ends. */
export type SubmissionCapturePublish = (captureId: number, output: TerminalSubmissionOutput) => void;

/**
 * How often a growing capture is published. A read between publishes sees
 * output up to this old; the mirror's own viewport digest runs at a similar
 * cadence.
 */
export const SUBMISSION_CAPTURE_PUBLISH_MS = 250;

/**
 * The one open capture beside a mirror (#16210). A terminal has a single
 * submit lane, so a new capture always ends the one before it, and a mirror
 * holds at most one at a time whatever the traffic.
 *
 * The owner calls `start`/`close` once everything fed before them has parsed,
 * and `sync` after every parse. Nothing here runs while no capture is open.
 */
export class SubmissionCaptureHost {
  private open:
    | { id: number; capture: SubmissionOutputCapture; published: string | undefined }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly publish: SubmissionCapturePublish) {}

  start(terminal: HeadlessTerminal, captureId: number, submittedText: string): void {
    this.close();
    const capture = new SubmissionOutputCapture(terminal, submittedText);
    this.open = { id: captureId, capture, published: undefined };
    this.publishOpen();
  }

  sync(): void {
    const open = this.open;
    if (open === undefined) return;
    open.capture.sync();
    if (!open.capture.isOpen) {
      // The cap, or lost rows, ended it.
      this.clearTimer();
      this.open = undefined;
      this.publish(open.id, open.capture.snapshot());
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.publishOpen();
    }, SUBMISSION_CAPTURE_PUBLISH_MS);
  }

  close(): void {
    const open = this.open;
    if (open === undefined) return;
    this.clearTimer();
    this.open = undefined;
    this.publish(open.id, open.capture.close());
  }

  dispose(): void {
    this.close();
  }

  private publishOpen(): void {
    const open = this.open;
    if (open === undefined) return;
    const output = open.capture.snapshot();
    const key = `${output.state}\u0000${output.truncated}\u0000${output.text}`;
    if (key === open.published) return;
    open.published = key;
    this.publish(open.id, output);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The longest start of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
export function cutToBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes so the cut lands on a code point boundary.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

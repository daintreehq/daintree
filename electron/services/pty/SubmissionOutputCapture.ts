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
 * fragments and every spinner frame. Lines are read as they leave the viewport
 * into scrollback, which is the point an inline TUI (Codex, Claude Code) stops
 * repainting them, so the capture holds what was finally shown and no longer
 * depends on how much scrollback the mirror keeps. Lines still on screen are
 * read live and only kept once the capture closes.
 *
 * Only whole logical lines are read, never part of a soft-wrapped one, so a
 * reflow can never move text across the boundary between read and unread.
 * Where the boundary sits is held by a marker on the last row read; when a
 * column change reflows the buffer, or something other than a scrollback trim
 * takes the marker, the boundary is found again by the text read before it.
 *
 * Two kinds of line reach scrollback without being output after the write:
 *
 * - The lines above the cursor when the Enter was written. They are matched by
 *   text as they scroll off and dropped; the first line that matches none of
 *   them ends the skipping for good.
 * - A replay. Codex purges scrollback (`CSI 3 J`) on a resize and re-emits its
 *   whole transcript reflowed to the new width, so the old history scrolls off
 *   again. After a purge, scrolled-off lines are searched for the tail of what
 *   had been read, compared with whitespace collapsed so a reflow's new line
 *   breaks still match; lines after the latest match are the continuation. A
 *   purge that never lines back up leaves the capture `lost`, keeping the text
 *   from before it.
 *
 * Bounded at {@link SUBMISSION_OUTPUT_MAX_LINES} lines and
 * {@link SUBMISSION_OUTPUT_MAX_BYTES} bytes, keeping the start: a goal-mode
 * agent may never settle, so the cap is what ends a capture, and past it the
 * capture does no further work. A replay's continuation is the exception: it
 * stops growing at the cap but stays open, since a later match would replace
 * it.
 */

/** Normalized characters an anchor keeps; long enough to be unique, short enough to survive a reflow. */
const ANCHOR_MAX_CHARS = 512;

/** Below this, read text is too little to find again, and the submitted text anchors instead. */
const ANCHOR_MIN_CHARS = 24;

/** Rows read back from the start boundary to seed the text before the write. */
const CONTEXT_ROWS = 64;

const WHITESPACE = /\s/;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Collapse whitespace runs to one space, the way the matcher reads its stream. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function anchorTail(text: string): string {
  return normalize(text).slice(-ANCHOR_MAX_CHARS).trimStart();
}

interface LogicalLine {
  text: string;
  /** Last buffer row of the line. */
  endRow: number;
}

/**
 * The logical lines from row `from`, skipping the continuation rows of a line
 * read before it. With `complete`, only lines that end before row `to`; else
 * every line from `from` to the end of the buffer.
 */
function readLines(
  buffer: IBuffer,
  from: number,
  to: number,
  complete: boolean
): { lines: LogicalLine[]; next: number } {
  const lines: LogicalLine[] = [];
  const limit = complete ? to : buffer.length;
  let row = Math.max(0, from);
  while (row < limit && buffer.getLine(row)?.isWrapped === true) row += 1;
  let next = row;
  while (row < limit) {
    let end = row;
    let text = buffer.getLine(row)?.translateToString(true) ?? "";
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped === true) {
      end += 1;
      text += buffer.getLine(end)?.translateToString(true) ?? "";
    }
    if (complete && end >= to) break;
    lines.push({ text: text.trimEnd(), endRow: end });
    row = end + 1;
    next = row;
  }
  return { lines, next };
}

/** Knuth-Morris-Pratt over the normalized stream, so a replay is searched once, line by line. */
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
   * Feed one logical line. Returns the index in `line` just past the latest
   * complete match inside it, or -1. A match can span lines.
   */
  feed(line: string): number {
    let end = -1;
    if (this.step(" ")) end = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (this.step(line[index]!)) end = index + 1;
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

/**
 * The lines that were on screen above the cursor at the write, dropped as they
 * scroll off. In order, tolerating one that was redrawn in between.
 */
class PreWriteSkip {
  private next = 0;

  constructor(private readonly lines: readonly string[]) {}

  clone(): PreWriteSkip {
    const copy = new PreWriteSkip(this.lines);
    copy.next = this.next;
    return copy;
  }

  /** True when `text` is one of the pre-write lines due next. */
  skips(text: string): boolean {
    const normalized = normalize(text);
    if (normalized === "") return true;
    const last = Math.min(this.next + 2, this.lines.length);
    for (let index = this.next; index < last; index += 1) {
      if (this.lines[index] === normalized) {
        this.next = index + 1;
        return true;
      }
    }
    return false;
  }

  get exhausted(): boolean {
    return this.next >= this.lines.length;
  }
}

/** Lines kept against the cap, which the journal and a replay's continuation each count. */
class Budget {
  readonly lines: string[] = [];
  bytes = 0;
  full = false;

  /** Add `text`, cut to what fits; false once the cap is reached. */
  add(text: string, base: { lines: number; bytes: number }): boolean {
    if (this.full) return false;
    const separator = base.lines + this.lines.length > 0 ? 1 : 0;
    if (base.lines + this.lines.length >= SUBMISSION_OUTPUT_MAX_LINES) {
      this.full = true;
      return false;
    }
    const room = SUBMISSION_OUTPUT_MAX_BYTES - base.bytes - this.bytes - separator;
    const fitted = utf8Bytes(text) <= room ? text : cutToBytes(text, Math.max(0, room));
    if (fitted !== text) {
      if (fitted !== "") {
        this.lines.push(fitted);
        this.bytes += utf8Bytes(fitted) + separator;
      }
      this.full = true;
      return false;
    }
    this.lines.push(text);
    this.bytes += utf8Bytes(text) + separator;
    return true;
  }

  get size(): { lines: number; bytes: number } {
    return { lines: this.lines.length, bytes: this.bytes };
  }
}

const EMPTY = { lines: 0, bytes: 0 };

interface Replay {
  anchor: string;
  matcher: AnchorMatcher;
  aligned: boolean;
  /** Lines after the latest match. */
  continuation: Budget;
  /** The anchor was the submitted text, so the journal read before the purge is replayed after it too. */
  replacesJournal: boolean;
}

export class SubmissionOutputCapture {
  private journal = new Budget();
  /** Normalized text read before the journal: the scrollback above the write and the pre-write lines skipped. */
  private context = "";
  private cols: number;
  /**
   * The last row read, once one is in scrollback. A marker rather than an
   * index because scrollback trims shift every index; and on a scrolled-off
   * row because xterm clears the markers on any screen row it erases.
   */
  private marker: IMarker | undefined;
  /** The next row to read while no marker is held: before anything is in scrollback, and after a purge. */
  private unmarkedNext = 0;
  private skip: PreWriteSkip | undefined;
  private replay: Replay | undefined;
  private purgeHandler: IDisposable | undefined;
  private state: TerminalSubmissionOutput["state"] = "capturing";

  constructor(
    private readonly terminal: HeadlessTerminal,
    private readonly submittedText: string
  ) {
    this.cols = terminal.cols;
    // The normal buffer holds the history even while a full-screen app shows
    // the alternate one, which leaves it untouched.
    const buffer = terminal.buffer.normal;
    let boundary = buffer.baseY;
    while (boundary > 0 && buffer.getLine(boundary)?.isWrapped === true) boundary -= 1;
    const before = readLines(buffer, Math.max(0, boundary - CONTEXT_ROWS), boundary, true);
    this.context = anchorTail(before.lines.map((line) => line.text).join(" "));
    const above = readLines(buffer, boundary, buffer.baseY + buffer.cursorY, true).lines;
    // Blank lines always skip, so only the others hold a place in the order.
    const skipped = above.map((line) => normalize(line.text)).filter((text) => text !== "");
    if (skipped.length > 0) this.skip = new PreWriteSkip(skipped);
    this.markReadUpTo(boundary);
    // Runs before xterm's own handler, so lines that scrolled off since the
    // last sync are read before the purge deletes them.
    this.purgeHandler = terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === 3 && terminal.buffer.active.type === "normal") this.notePurge();
      return false;
    });
  }

  get isOpen(): boolean {
    return this.state === "capturing";
  }

  /** Read the lines that scrolled off since the last call. Call after each parse. */
  sync(): void {
    this.readScrolledOff(false);
  }

  /** What has been captured, with the lines still on screen read live. */
  snapshot(): TerminalSubmissionOutput {
    this.sync();
    if (this.state !== "capturing") return this.render(this.journal.lines, this.state);
    const live = this.readLive();
    return this.render(this.keptWith(live), this.state);
  }

  /** End the capture, keeping the lines still on screen, and return its final form. */
  close(): TerminalSubmissionOutput {
    if (this.state === "capturing") {
      this.sync();
      if (this.state === "capturing") {
        const live = this.readLive();
        if (!live.aligned) {
          this.finish("lost");
        } else {
          const lines = this.keptWith(live);
          const cut = this.journal.full || this.replay?.continuation.full === true;
          this.journal = new Budget();
          for (const line of lines) if (!this.journal.add(line, EMPTY)) break;
          if (cut) this.journal.full = true;
          this.finish("closed");
        }
      }
    }
    return this.render(this.journal.lines, this.state);
  }

  dispose(): void {
    if (this.state === "capturing") this.finish("closed");
    this.release();
  }

  /**
   * Read every complete line between the boundary and scrollback's end. With
   * `tolerant`, a boundary that cannot be found again is left for a purge to
   * re-establish instead of ending the capture.
   */
  private readScrolledOff(tolerant: boolean): void {
    if (this.state !== "capturing") return;
    const buffer = this.terminal.buffer.normal;
    let from = this.columnsChanged() ? undefined : this.boundary();
    if (from === undefined) {
      from = this.realign();
      if (from === undefined) {
        if (!tolerant) this.finish("lost");
        return;
      }
    }
    const { lines, next } = readLines(buffer, from, buffer.baseY, true);
    for (const line of lines) {
      this.take(line.text);
      if (this.state !== "capturing") return;
    }
    if (next !== from) this.markReadUpTo(next);
  }

  private columnsChanged(): boolean {
    if (this.terminal.cols === this.cols) return false;
    this.cols = this.terminal.cols;
    return true;
  }

  /** The first unread row, or undefined when the marker is gone. */
  private boundary(): number | undefined {
    const marker = this.marker;
    if (marker !== undefined) return marker.isDisposed ? undefined : marker.line + 1;
    // Without a marker nothing tracks a trim, and trimming happens only once
    // scrollback is full; from then on the index is found again by content.
    const buffer = this.terminal.buffer.normal;
    const full = buffer.length >= this.terminal.rows + (this.terminal.options.scrollback ?? 0);
    if (this.unmarkedNext > 0 && full) return undefined;
    return this.unmarkedNext;
  }

  /**
   * Find the boundary again by the text read before it, after a reflow or a
   * marker taken by an erase. Undefined when that text is gone, which a
   * scrollback trim is the usual cause of.
   */
  private realign(): number | undefined {
    const replay = this.replay;
    if (replay !== undefined) {
      // A replay is found by content anyway: read it all again from the top.
      replay.matcher = new AnchorMatcher(replay.anchor);
      replay.aligned = false;
      replay.continuation = new Budget();
      this.markReadUpTo(0);
      return 0;
    }
    const anchor = anchorTail(this.readText());
    if (anchor === "") {
      this.markReadUpTo(0);
      return 0;
    }
    const buffer = this.terminal.buffer.normal;
    const matcher = new AnchorMatcher(anchor);
    let next: number | undefined;
    for (const line of readLines(buffer, 0, buffer.length, false).lines) {
      if (matcher.feed(line.text) >= 0) next = line.endRow + 1;
    }
    if (next !== undefined) this.markReadUpTo(next);
    return next;
  }

  /** Everything read so far, as one normalized stream. */
  private readText(): string {
    const parts = [this.context, ...this.journal.lines];
    if (this.replay?.aligned === true) parts.push(...this.replay.continuation.lines);
    return parts.join(" ");
  }

  /** Note every row above `line` as read. */
  private markReadUpTo(line: number): void {
    this.marker?.dispose();
    this.marker = undefined;
    this.unmarkedNext = line;
    // A marker can only go on the buffer that shows, and the normal one does
    // not move while the alternate one does.
    if (line === 0 || this.terminal.buffer.active.type !== "normal") return;
    const buffer = this.terminal.buffer.normal;
    this.marker = this.terminal.registerMarker(line - 1 - (buffer.baseY + buffer.cursorY));
  }

  private notePurge(): void {
    if (this.state !== "capturing") return;
    this.readScrolledOff(true);
    if (this.state !== "capturing") return;
    this.commitContinuation();
    if (this.state !== "capturing") return;
    const journal = this.journal.lines;
    const submitted = anchorTail(this.submittedText);
    // Nothing after the write has been read yet: the question's echo marks
    // where the answer starts, without the pre-write lines still on screen.
    const read = anchorTail(this.readText());
    let anchor = read;
    let replacesJournal = false;
    if (
      (journal.length === 0 && submitted.length >= ANCHOR_MIN_CHARS) ||
      (read.length < ANCHOR_MIN_CHARS && submitted !== "")
    ) {
      // The echo of the question precedes everything after it, so the
      // journal read before the purge comes back in the continuation.
      anchor = submitted;
      replacesJournal = true;
    }
    this.skip = undefined;
    if (anchor === "") return this.finish("lost");
    this.replay = {
      anchor,
      matcher: new AnchorMatcher(anchor),
      aligned: false,
      continuation: new Budget(),
      replacesJournal,
    };
    // Every row in scrollback goes with the purge, so reading starts over.
    this.markReadUpTo(0);
  }

  /** Fold an aligned replay's continuation into the journal. */
  private commitContinuation(): void {
    const replay = this.replay;
    if (replay === undefined) return;
    this.replay = undefined;
    if (!replay.aligned) return;
    if (replay.replacesJournal) this.journal = new Budget();
    for (const line of replay.continuation.lines) {
      if (!this.journal.add(line, EMPTY)) return this.finish("closed");
    }
    if (replay.continuation.full) this.finish("closed");
  }

  private take(text: string): void {
    const replay = this.replay;
    if (replay !== undefined) {
      const end = replay.matcher.feed(text);
      if (end >= 0) {
        replay.aligned = true;
        replay.continuation = new Budget();
        const rest = text.slice(end).trimStart();
        if (rest !== "") replay.continuation.add(rest, this.replayBase(replay));
      } else if (replay.aligned) {
        replay.continuation.add(text, this.replayBase(replay));
      }
      return;
    }
    if (this.skip !== undefined) {
      if (this.skip.skips(text)) {
        this.context = anchorTail(`${this.context} ${text}`);
        if (this.skip.exhausted) this.skip = undefined;
        return;
      }
      this.skip = undefined;
    }
    if (!this.journal.add(text, EMPTY)) this.finish("closed");
  }

  private replayBase(replay: Replay): { lines: number; bytes: number } {
    return replay.replacesJournal ? EMPTY : this.journal.size;
  }

  /**
   * Lines on screen below what has been read, through copies of the skip and
   * replay state.
   */
  private readLive(): { lines: string[]; aligned: boolean; replaced: boolean } {
    const active = this.terminal.buffer.active;
    if (active.type !== "normal") {
      // A full-screen app: what it shows is all there is to read live.
      const lines = readLines(active, active.baseY, active.length, false).lines.map((l) => l.text);
      return {
        lines: trimTrailingBlank(lines),
        aligned: this.replay?.aligned ?? true,
        replaced: false,
      };
    }
    const from = this.boundary() ?? active.baseY;
    const replay = this.replay;
    let skip = replay === undefined ? this.skip?.clone() : undefined;
    const matcher = replay?.matcher.clone();
    let aligned = replay?.aligned ?? true;
    let replaced = false;
    let lines: string[] = [];
    for (const { text } of readLines(active, from, active.length, false).lines) {
      if (matcher !== undefined) {
        const end = matcher.feed(text);
        if (end >= 0) {
          aligned = true;
          replaced = true;
          lines = [];
          const rest = text.slice(end).trimStart();
          if (rest !== "") lines.push(rest);
          continue;
        }
        if (!aligned) continue;
      } else if (skip !== undefined) {
        if (skip.skips(text)) continue;
        skip = undefined;
      }
      lines.push(text);
    }
    return { lines: trimTrailingBlank(lines), aligned, replaced };
  }

  /** The journal, a replay's continuation, then live lines. */
  private keptWith(live: { lines: string[]; replaced: boolean }): string[] {
    const replay = this.replay;
    if (replay === undefined) return [...this.journal.lines, ...live.lines];
    const journal =
      replay.replacesJournal && (replay.aligned || live.replaced) ? [] : this.journal.lines;
    const continuation = live.replaced ? [] : replay.continuation.lines;
    return [...journal, ...continuation, ...live.lines];
  }

  private render(
    lines: readonly string[],
    state: TerminalSubmissionOutput["state"]
  ): TerminalSubmissionOutput {
    const kept = [...lines];
    while (kept.length > 0 && kept[0]!.trim() === "") kept.shift();
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    let truncated = this.journal.full || this.replay?.continuation.full === true;
    if (kept.length > SUBMISSION_OUTPUT_MAX_LINES) {
      kept.length = SUBMISSION_OUTPUT_MAX_LINES;
      truncated = true;
    }
    let text = kept.join("\n");
    if (utf8Bytes(text) > SUBMISSION_OUTPUT_MAX_BYTES) {
      text = cutToBytes(text, SUBMISSION_OUTPUT_MAX_BYTES);
      truncated = true;
    }
    return { text, truncated, state };
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

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * Runs work once everything fed to a mirror before it has parsed. Counted off
 * the feed's own parse callbacks rather than a sentinel write: xterm's
 * synchronous drain (run by every resize) stops at an empty write and drops
 * everything queued behind it, and any non-empty sentinel would land in
 * whatever escape sequence the stream had left open.
 */
export class ParseBarrier {
  private fed = 0;
  private parsed = 0;
  private waiters: Array<{ seq: number; run: () => void }> = [];

  noteFed(): void {
    this.fed += 1;
  }

  noteParsed(): void {
    this.parsed += 1;
    while (this.waiters.length > 0 && this.waiters[0]!.seq <= this.parsed) {
      this.waiters.shift()!.run();
    }
  }

  after(run: () => void): void {
    if (this.parsed >= this.fed) run();
    else this.waiters.push({ seq: this.fed, run });
  }

  /** Forget what was fed: the mirror it counted is gone or replaced. */
  reset(): void {
    this.fed = 0;
    this.parsed = 0;
    this.waiters = [];
  }
}

/** Receives a capture's output as it grows, and once more, final, when it ends. */
export type SubmissionCapturePublish = (
  captureId: number,
  output: TerminalSubmissionOutput
) => void;

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
    { id: number; capture: SubmissionOutputCapture; published: string | undefined } | undefined;
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
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes so the cut lands on a code point boundary.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

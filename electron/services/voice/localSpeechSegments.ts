/**
 * Cuts the on-device model's token stream into the passages dictation
 * completes, by audio position rather than by when a token was decoded. A
 * pause closes its passage at a point just past where speech stopped, once
 * decoding has reached that point, so a word decoded late still lands before
 * its pause and a word spoken after the pause never does, however the audio
 * was split into packets and chunks. Enter and stop close what has been
 * decoded at once (the caller flushes first); a passage of continuous speech
 * past the cap is closed at the next word.
 */

export interface SegmentVocabulary {
  decode(ids: readonly number[]): string;
  /** A piece that starts a new word. */
  startsWord(id: number): boolean;
}

export interface TimedToken {
  id: number;
  /** Where in the session's audio it was emitted, in ms. */
  atMs: number;
}

export type SegmentCloseReason = "pause" | "cap" | "cut" | "finish";

export type SegmentEvent =
  | { type: "text"; segment: number; text: string }
  | { type: "end"; segment: number; text: string; shown: boolean; reason: SegmentCloseReason };

/** Past this much continuous speech, a passage is closed at the next word. */
export const SEGMENT_CAP_MS = 15_000;

/**
 * The model writes a sentence's closing punctuation only once it hears what
 * comes next, so a passage after a pause can open with the last one's comma
 * or full stop; it belongs to the passage already completed. An ASCII mark
 * goes only where a space or the end follows it, so `.env` keeps its dot.
 */
const LEADING_CLOSERS = /^(?:\s|[.,;:!?…](?=[\s.,;:!?…]|$)|[。、，．！？；：])+/u;

export function segmentText(vocabulary: SegmentVocabulary, ids: readonly number[]): string {
  return vocabulary.decode(ids).replace(/\s+/g, " ").replace(LEADING_CLOSERS, "").trimEnd();
}

export class LocalSpeechSegmenter {
  private segment = 0;
  private ids: number[] = [];
  private firstAtMs: number | null = null;
  private shownText = "";
  /** Pause closes waiting for decoding to pass them, in order. */
  private pendingCloses: number[] = [];

  constructor(
    private readonly vocabulary: SegmentVocabulary,
    private readonly capMs = SEGMENT_CAP_MS
  ) {}

  /** Where the next pause waiting on decoding closes its passage; null when none waits. */
  nextCloseAt(): number | null {
    return this.pendingCloses[0] ?? null;
  }

  /** A pause ended speech: close the open passage at `atMs` once decoding passes it. */
  closeAt(atMs: number): void {
    const last = this.pendingCloses[this.pendingCloses.length - 1];
    if (last !== undefined && atMs <= last) return;
    this.pendingCloses.push(atMs);
  }

  /**
   * One decoded chunk's tokens, then how far decoding has reached. Returns the
   * passages it closes and the open passage's text when that changed.
   */
  addChunk(tokens: readonly TimedToken[], decodedThroughMs: number): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    for (const token of tokens) {
      while (this.pendingCloses.length > 0 && token.atMs >= this.pendingCloses[0]) {
        this.pendingCloses.shift();
        this.close("pause", events);
      }
      if (
        this.firstAtMs !== null &&
        token.atMs - this.firstAtMs >= this.capMs &&
        this.vocabulary.startsWord(token.id)
      ) {
        this.close("cap", events);
      }
      this.firstAtMs ??= token.atMs;
      this.ids.push(token.id);
    }
    while (this.pendingCloses.length > 0 && decodedThroughMs >= this.pendingCloses[0]) {
      this.pendingCloses.shift();
      this.close("pause", events);
    }
    this.showOpen(events);
    return events;
  }

  /** Enter or stop: everything decoded so far is one passage, closed now. */
  closeNow(reason: "cut" | "finish"): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    this.pendingCloses = [];
    this.close(reason, events);
    return events;
  }

  private showOpen(events: SegmentEvent[]): void {
    const text = segmentText(this.vocabulary, this.ids);
    if (text === this.shownText) return;
    this.shownText = text;
    events.push({ type: "text", segment: this.segment, text });
  }

  private close(reason: SegmentCloseReason, events: SegmentEvent[]): void {
    const text = segmentText(this.vocabulary, this.ids);
    const shown = this.shownText !== "";
    events.push({ type: "end", segment: this.segment, text, shown, reason });
    this.segment++;
    this.ids = [];
    this.firstAtMs = null;
    this.shownText = "";
  }
}

import { describe, expect, it } from "vitest";
import {
  LocalSpeechSegmenter,
  segmentText,
  type SegmentVocabulary,
  type TimedToken,
} from "../localSpeechSegments.js";

// Ids index this list; "▁" starts a word.
const PIECES = ["▁Fix", "▁the", "▁test", ",", "▁then", "▁send", "▁it", ".", "▁and", "s"];
const vocab: SegmentVocabulary = {
  decode: (ids) => ids.map((id) => PIECES[id].replaceAll("▁", " ")).join(""),
  startsWord: (id) => PIECES[id].startsWith("▁"),
};
const t = (id: number, atMs: number): TimedToken => ({ id, atMs });

describe("LocalSpeechSegmenter", () => {
  it("shows the open passage as it grows, once per change", () => {
    const s = new LocalSpeechSegmenter(vocab);
    expect(s.addChunk([t(0, 100), t(1, 300)], 560)).toEqual([
      { type: "text", segment: 0, text: "Fix the" },
    ]);
    expect(s.addChunk([], 1120)).toEqual([]);
  });

  it("closes a passage at a pause once decoding passes the pause", () => {
    const s = new LocalSpeechSegmenter(vocab);
    s.addChunk([t(0, 100), t(1, 300)], 560);
    s.closeAt(800);
    // Decoding hasn't reached the pause yet: nothing closes.
    expect(s.addChunk([], 560).filter((e) => e.type === "end")).toEqual([]);
    expect(s.addChunk([], 1120)).toEqual([
      { type: "end", segment: 0, text: "Fix the", shown: true, reason: "pause", atMs: 800 },
    ]);
  });

  it("keeps a word decoded late on its side of the pause, and puts the next words after it", () => {
    const s = new LocalSpeechSegmenter(vocab);
    s.addChunk([t(0, 100), t(1, 300)], 560);
    s.closeAt(800);
    // One chunk brings the last word before the pause and the first one after it.
    const events = s.addChunk([t(2, 600), t(4, 1000), t(5, 1080)], 1120);
    expect(events).toEqual([
      { type: "end", segment: 0, text: "Fix the test", shown: true, reason: "pause", atMs: 800 },
      { type: "text", segment: 1, text: "then send" },
    ]);
  });

  it("moves a deferred closing punctuation mark off the next passage", () => {
    const s = new LocalSpeechSegmenter(vocab);
    s.addChunk([t(0, 100)], 560);
    s.closeAt(700);
    const events = s.addChunk([t(3, 900), t(4, 950), t(5, 1000), t(6, 1050)], 1120);
    expect(events.at(-1)).toEqual({ type: "text", segment: 1, text: "then send it" });
  });

  it("closes continuous speech past the cap at the next word, never inside one", () => {
    const s = new LocalSpeechSegmenter(vocab, 1_000);
    s.addChunk([t(0, 0), t(1, 400)], 560);
    const events = s.addChunk([t(8, 900), t(9, 1050), t(4, 1100)], 1120);
    expect(events).toEqual([
      { type: "end", segment: 0, text: "Fix the ands", shown: true, reason: "cap" },
      { type: "text", segment: 1, text: "then" },
    ]);
  });

  it("closes everything decoded at Enter and at stop, dropping pending pauses", () => {
    const s = new LocalSpeechSegmenter(vocab);
    s.addChunk([t(0, 100)], 560);
    s.closeAt(5_000);
    expect(s.closeNow("cut")).toEqual([
      { type: "end", segment: 0, text: "Fix", shown: true, reason: "cut" },
    ]);
    s.addChunk([t(5, 6_000)], 6_100);
    expect(s.closeNow("finish")).toEqual([
      { type: "end", segment: 1, text: "send", shown: true, reason: "finish" },
    ]);
  });

  it("closes an empty passage as not shown", () => {
    const s = new LocalSpeechSegmenter(vocab);
    s.closeAt(100);
    expect(s.addChunk([], 560)).toEqual([
      { type: "end", segment: 0, text: "", shown: false, reason: "pause", atMs: 100 },
    ]);
  });

  it("ignores a pause at or before one already waiting", () => {
    const s = new LocalSpeechSegmenter(vocab);
    s.addChunk([t(0, 100)], 200);
    s.closeAt(800);
    s.closeAt(700);
    expect(s.addChunk([], 1120).filter((e) => e.type === "end")).toHaveLength(1);
  });
});

describe("segmentText", () => {
  it("collapses whitespace and drops leading closers", () => {
    expect(segmentText(vocab, [3, 7, 4, 5])).toBe("then send");
    expect(segmentText({ ...vocab, decode: () => "  ， 下一步  " }, [])).toBe("下一步");
    // A dot that starts a word stays: it isn't the last passage's full stop.
    expect(segmentText({ ...vocab, decode: () => " .env is missing" }, [])).toBe(".env is missing");
    expect(segmentText({ ...vocab, decode: () => ". Then" }, [])).toBe("Then");
    expect(segmentText({ ...vocab, decode: () => ".，Then" }, [])).toBe("Then");
  });
});

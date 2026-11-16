import { describe, it, expect, vi } from "vitest";
import headless, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { PARSER_GROUND, PartialEscapeTracker } from "../terminalPartialEscapeTail.js";

const { Terminal } = headless;
const { SerializeAddon } = serialize;

function makeTerminal(): { term: HeadlessTerminal; addon: InstanceType<typeof SerializeAddon> } {
  const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  const addon = new SerializeAddon();
  term.loadAddon(addon as unknown as Parameters<HeadlessTerminal["loadAddon"]>[0]);
  return { term, addon };
}

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

interface Observed {
  lines: string[];
  cursor: [number, number];
  fg: number[];
  title: string;
}

function observe(term: HeadlessTerminal, title: string): Observed {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  const fg: number[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    lines.push(line.translateToString(true));
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell && cell.getChars()) fg.push(cell.getFgColor());
    }
  }
  return { lines, cursor: [buffer.cursorX, buffer.cursorY], fg, title };
}

function trackTitle(term: HeadlessTerminal): () => string {
  let title = "";
  term.onTitleChange((t) => (title = t));
  return () => title;
}

async function uninterrupted(stream: string): Promise<Observed> {
  const { term } = makeTerminal();
  const title = trackTitle(term);
  await write(term, stream);
  return observe(term, title());
}

/**
 * The source consumes `stream[0:split]`, is serialized, and a fresh
 * destination replays CAN + snapshot + tail and then the rest of the stream.
 */
async function restoredAt(stream: string, split: number, withTail = true): Promise<Observed> {
  const source = makeTerminal();
  const tracker = new PartialEscapeTracker();
  await write(source.term, stream.slice(0, split));
  tracker.feed(stream.slice(0, split));
  const snapshot = source.addon.serialize();

  const dest = makeTerminal();
  const title = trackTitle(dest.term);
  const tail = withTail ? (tracker.tail ?? "") : "";
  await write(dest.term, PARSER_GROUND + snapshot + tail);
  await write(dest.term, stream.slice(split));
  return observe(dest.term, title());
}

// Titles are not screen state and never ride a snapshot: a title the source
// already dispatched is outside what a restore can reproduce.
const screen = ({ title: _title, ...rest }: Observed) => rest;

const CASES: Record<string, { stream: string; split: number; titleOnSource?: boolean }> = {
  "CSI SGR": { stream: "hello \x1b[31mRED", split: "hello \x1b[3".length },
  "OSC title (BEL)": { stream: "hello \x1b]0;title\x07world", split: "hello \x1b]0;ti".length },
  "OSC title (ST)": { stream: "hello \x1b]0;title\x1b\\world", split: "hello \x1b]0;tit".length },
  // The ESC already dispatched the title on the source; what is left pending
  // is a lone ESC whose `\` must not print.
  "ST split after its ESC": {
    stream: "hello \x1b]0;title\x1b\\world",
    split: "hello \x1b]0;title\x1b".length,
    titleOnSource: true,
  },
  "lone ESC": { stream: "hello \x1b[31mRED", split: "hello \x1b".length },
  "cursor position": { stream: "hello \x1b[2;3Hworld", split: "hello \x1b[2;".length },
  // xterm's decoder discards U+FEFF before its parser...
  "BOM inside a CSI": {
    stream: "hello \x1b\ufeff[31mRED",
    split: "hello \x1b\ufeff[3".length,
  },
  "BOM inside an OSC title": {
    stream: "hello \x1b]0;ti\ufefftle\x07world",
    split: "hello \x1b]0;ti\ufeff".length,
  },
  // ...except as the unit a high surrogate takes for its partner.
  "BOM after a lone surrogate in an OSC title": {
    stream: "hello \x1b]0;a\ud800\ufeffb\x07world",
    split: "hello \x1b]0;a\ud800\ufeff".length,
  },
  "BOM after a surrogate that took a NUL": {
    stream: "hello \x1b]0;a\ud800\0\ufeffb\x07world",
    split: "hello \x1b]0;a\ud800\0\ufeff".length,
  },
};

describe("PartialEscapeTracker", () => {
  for (const [name, { stream, split, titleOnSource }] of Object.entries(CASES)) {
    const view = titleOnSource ? screen : (o: Observed) => o;
    it(`restores a ${name} split the same as uninterrupted playback`, async () => {
      expect(view(await restoredAt(stream, split))).toEqual(view(await uninterrupted(stream)));
    });

    it(`garbles a ${name} split without the tail (the defect)`, async () => {
      expect(view(await restoredAt(stream, split, false))).not.toEqual(
        view(await uninterrupted(stream))
      );
    });
  }

  it("matches uninterrupted playback at every split of a mixed stream", async () => {
    const stream =
      "a\x1b[1;31mb\x1b]0;t\x1bitle\x07c\x1b[2;4Hd\x1bPq#0;2;0;0;0\x1b\\e\x9b32mf\x1b(Bg" +
      "\x1b[3\n2mh\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\é😀\x1b_Gx\x1b\\i" +
      "\x1b^pmé j\x1bP$q\x7fm\x1b\\k\x1bX sos \x07 still\x1b\\l";
    const expected = screen(await uninterrupted(stream));
    for (let split = 0; split <= stream.length; split++) {
      // PTY strings are decoded whole, so a split never lands inside a
      // surrogate pair.
      const code = stream.charCodeAt(split);
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      expect(screen(await restoredAt(stream, split)), `split at ${split}`).toEqual(expected);
    }
  });

  it("reports ground as an empty tail", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feed("plain \x1b[31mtext\x1b]0;x\x07");
    expect(tracker.tail).toBe("");
  });

  it("does not retain C0 controls the parser already executed mid-CSI", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feed("\x1b[3\r\n");
    expect(tracker.tail).toBe("\x1b[3");
  });

  it("keeps only the ESC after a string terminated by ESC", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feed("\x1b]0;title\x1b");
    expect(tracker.tail).toBe("\x1b");
  });

  it("leaves a discarded U+FEFF out of the tail", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feed("\x1b]0;ti\ufefftle");
    expect(tracker.tail).toBe("\x1b]0;title");
  });

  // Replay would discard a wrongly kept U+FEFF again, so check the tails.
  for (const [writes, tail] of [
    [["\x1b]0;a\ud800", "\ufeffb"], "\x1b]0;a\ud800\ufeffb"],
    [["\x1b]0;a\ud800\ud800", "\ufeffb"], "\x1b]0;a\ud800\ud800b"],
    [["\x1b]0;a", "\ud800", "\ud800", "\ufeffb"], "\x1b]0;a\ud800\ud800b"],
    [["\x1b]0;a", "\ud800", "", "\ufeffb"], "\x1b]0;a\ud800\ufeffb"],
  ] as const) {
    it(`keeps a U+FEFF only as a held surrogate's partner: ${JSON.stringify(writes)}`, () => {
      const tracker = new PartialEscapeTracker();
      for (const chunk of writes) tracker.feed(chunk);
      expect(tracker.tail).toBe(tail);
    });
  }

  // The source decodes each write as it comes, holding a high surrogate that
  // ends one for the next.
  for (const writes of [
    ["\x1b]0;a\ud800", "\ufeffb"],
    ["\x1b]0;a\ud800", "\0\ufeffb"],
    ["\x1b]0;a\ud800\0", "\ufeffb"],
    ["\x1b]0;a\ud800", "", "\ufeffb"],
    ["\x1b]0;a\ud800\ud800", "\ufeffb"],
    ["\x1b]0;a", "\ud800", "\ud800", "\ufeffb"],
  ]) {
    it(`restores a title written as ${JSON.stringify(writes)} the same as uninterrupted playback`, async () => {
      const source = makeTerminal();
      const tracker = new PartialEscapeTracker();
      for (const chunk of writes) {
        await write(source.term, chunk);
        tracker.feed(chunk);
      }
      const dest = makeTerminal();
      const title = trackTitle(dest.term);
      await write(dest.term, PARSER_GROUND + source.addon.serialize() + (tracker.tail ?? ""));
      await write(dest.term, "\x07world");
      expect(observe(dest.term, title())).toEqual(
        await uninterrupted(writes.join("") + "\x07world")
      );
    });
  }

  for (const [name, stream] of [
    ["OSC", "\x1b]0;" + "p".repeat(5000)],
    ["DCS", "\x1bP1$q" + "m".repeat(5000)],
    ["APC", "\x1b_G" + "x".repeat(5000)],
  ] as const) {
    it(`keeps a ${name} payload between the header and string caps whole`, () => {
      const fromString = new PartialEscapeTracker();
      fromString.feed(stream);
      const fromBytes = new PartialEscapeTracker();
      fromBytes.feedBytes(new TextEncoder().encode(stream));
      expect(fromString.tail).toBe(stream);
      expect(fromBytes.tail).toBe(stream);
    });
  }

  it("checks a header against its own cap however the input is split", () => {
    const stream = "\x1bP" + "1".repeat(9000) + "qpayload";
    const whole = new PartialEscapeTracker();
    whole.feed(stream);
    const bytes = new PartialEscapeTracker();
    bytes.feedBytes(new TextEncoder().encode(stream));
    const split = new PartialEscapeTracker();
    split.feed(stream.slice(0, 5000));
    split.feed(stream.slice(5000));
    expect(whole.tail).toBe("\x1bP0?");
    expect(bytes.tail).toBe(whole.tail);
    expect(split.tail).toBe(whole.tail);
  });

  it("drops the pending sequence on CAN and SUB", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feed("\x1b]0;ti\x18");
    expect(tracker.tail).toBe("");
    tracker.feed("\x1bP1$q\x1a");
    expect(tracker.tail).toBe("");
  });

  it("accumulates a sequence split across many feeds", () => {
    const tracker = new PartialEscapeTracker();
    for (const ch of "\x1b]0;long title") tracker.feed(ch);
    expect(tracker.tail).toBe("\x1b]0;long title");
  });

  it("stands in for an oversized string and recovers at its terminator", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feed("\x1b]52;c;" + "A".repeat(70000));
    // Not the truncated payload: a clipboard write of half the data would be
    // worse than none. The stand-in swallows the rest without dispatching.
    expect(tracker.tail).not.toContain("52;");
    tracker.feed("A\x07");
    expect(tracker.tail).toBe("");
    tracker.feed("\x1b[3");
    expect(tracker.tail).toBe("\x1b[3");
  });

  it("seeds from a tail and continues tracking from it", () => {
    const tracker = new PartialEscapeTracker();
    tracker.seed("\x1b]0;ti");
    tracker.feed("tle");
    expect(tracker.tail).toBe("\x1b]0;title");
    tracker.seed(null);
    expect(tracker.tail).toBe("");
  });

  it("has no visible effect when CAN reaches a parser already in ground", async () => {
    const plain = makeTerminal();
    await write(plain.term, "abc");
    const grounded = makeTerminal();
    await write(grounded.term, PARSER_GROUND + "abc");
    expect(observe(grounded.term, "")).toEqual(observe(plain.term, ""));
  });

  it("grounds a destination left mid-sequence before a restore (xterm #5019)", async () => {
    for (const pending of ["\x1b[2;", "\x1b]0;ti", "\x1bP1$q", "\x1b"]) {
      const expected = makeTerminal();
      await write(expected.term, "hello");

      const dest = makeTerminal();
      await write(dest.term, pending);
      dest.term.reset();
      await write(dest.term, PARSER_GROUND + "hello");
      expect(observe(dest.term, ""), JSON.stringify(pending)).toEqual(observe(expected.term, ""));
    }
  });
});

describe("PartialEscapeTracker overflow stand-ins", () => {
  for (const [name, head, rest] of [
    ["OSC", "a\x1b]0;" + "t".repeat(70000), "t\x07b"],
    ["DCS", "a\x1bP1$q" + "m".repeat(70000), "m\x1b\\b"],
    ["APC", "a\x1b_G" + "x".repeat(70000), "x\x1b\\b"],
    ["CSI", "a\x1b[" + "1;".repeat(3000), "1mb"],
  ] as const) {
    it(`swallows the continuation of an oversized ${name} without printing it`, async () => {
      const tracker = new PartialEscapeTracker();
      tracker.feed(head);
      const dest = makeTerminal();
      await write(dest.term, PARSER_GROUND + "a" + (tracker.tail ?? ""));
      await write(dest.term, rest);
      expect(dest.term.buffer.active.getLine(0)?.translateToString(true)).toBe("ab");
    });
  }
});

describe("PartialEscapeTracker byte input", () => {
  const encoder = new TextEncoder();

  it("tracks UTF-8 chunks the same as their decoded strings", () => {
    const stream = "héllo \x1b[1;3" + "\u009b3" + "é\x1b]0;tï" + "tle\x07 \x1b";
    for (let split = 0; split <= stream.length; split++) {
      const code = stream.charCodeAt(split);
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      const fromStrings = new PartialEscapeTracker();
      fromStrings.feed(stream.slice(0, split));
      fromStrings.feed(stream.slice(split));
      const fromBytes = new PartialEscapeTracker();
      fromBytes.feedBytes(encoder.encode(stream.slice(0, split)));
      fromBytes.feedBytes(encoder.encode(stream.slice(split)));
      expect(fromBytes.tail, `split at ${split}`).toBe(fromStrings.tail);
    }
  });

  it("keeps a pending string across a chunk with no controls", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feedBytes(encoder.encode("\x1b]0;ti"));
    tracker.feedBytes(encoder.encode("tle"));
    expect(tracker.tail).toBe("\x1b]0;title");
  });

  function decodedBytesWhile(fn: () => void): number {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      fn();
      return decode.mock.calls.reduce(
        (sum, [input]) => sum + ((input as Uint8Array | undefined)?.byteLength ?? 0),
        0
      );
    } finally {
      decode.mockRestore();
    }
  }

  it("does not decode the plain output after a sequence that finished", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feedBytes(encoder.encode("\x1b[3"));
    expect(tracker.tail).toBe("\x1b[3");

    const chunk = encoder.encode("\x1b[0m" + "x".repeat(64 * 1024));
    const decoded = decodedBytesWhile(() => tracker.feedBytes(chunk));
    expect(tracker.tail).toBe("");
    expect(decoded).toBeGreaterThan(0);
    expect(decoded).toBeLessThan(chunk.byteLength / 64);

    // The same plain run with a sequence left open at its end still tracks it.
    tracker.feedBytes(encoder.encode("\x1b[0m" + "x".repeat(64 * 1024) + "\x1b[3"));
    expect(tracker.tail).toBe("\x1b[3");
  });

  it("stops decoding a carried-over sequence once it finishes", () => {
    const tracker = new PartialEscapeTracker();
    tracker.feedBytes(encoder.encode("\x1b]0;ti"));
    expect(tracker.tail).toBe("\x1b]0;ti");

    const chunk = encoder.encode("tle\x07" + "y".repeat(64 * 1024));
    const decoded = decodedBytesWhile(() => tracker.feedBytes(chunk));
    expect(tracker.tail).toBe("");
    expect(decoded).toBeGreaterThan(0);
    expect(decoded).toBeLessThan(chunk.byteLength / 64);

    // A continuation without its terminator stays pending, all of it.
    tracker.feedBytes(encoder.encode("\x1b]0;ti"));
    tracker.feedBytes(encoder.encode("tle" + "y".repeat(1000)));
    expect(tracker.tail).toBe("\x1b]0;title" + "y".repeat(1000));
  });

  const wholeDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

  it("decodes a long pending string window by window as the whole chunk would", () => {
    const bom = [0xef, 0xbb, 0xbf];
    const stray = new Array<number>(700).fill(0x80);
    for (let pad = 0; pad < 4; pad++) {
      for (const [opener, closer] of [
        ["\x1b]0;", "\x07after"],
        ["\x1bP1$q", ""],
        ["\x1b_G", ""],
      ] as const) {
        // Some of the BOMs land at window starts.
        const body = "a".repeat(pad) + "é€😀\ufeff".repeat(400);
        const bytes = Uint8Array.from([
          ...encoder.encode(opener + body),
          ...bom,
          ...stray,
          ...encoder.encode(body + closer),
        ]);
        const fromBytes = new PartialEscapeTracker();
        fromBytes.feedBytes(bytes);
        const fromString = new PartialEscapeTracker();
        fromString.feed(wholeDecoder.decode(bytes));
        expect(fromBytes.tail, `${JSON.stringify(opener)} pad ${pad}`).toBe(fromString.tail);
      }
    }
  });

  it("decodes malformed UTF-8 at every window boundary as the whole chunk would", () => {
    const samples: number[][] = [
      [0xe2, 0x82], // truncated
      [0xc0, 0xaf], // overlong
      [0xed, 0xa0, 0x80], // encoded surrogate
      [0xf4, 0x90, 0x80, 0x80], // past U+10FFFF
      [0xf0, 0x9f, 0x98, 0x80], // valid 4-byte
      [0xef, 0xbb, 0xbf], // BOM
      new Array<number>(1100).fill(0x80), // stray run longer than the next window
    ];
    const opener = encoder.encode("\x1b]0;");
    for (const boundary of [256, 256 + 512]) {
      for (const sample of samples) {
        for (let at = boundary - 5; at <= boundary + 1; at++) {
          const bytes = Uint8Array.from([
            ...opener,
            ...new Array<number>(at - opener.length).fill(0x61),
            ...sample,
            ...encoder.encode("tail"),
          ]);
          const fromBytes = new PartialEscapeTracker();
          fromBytes.feedBytes(bytes);
          const fromString = new PartialEscapeTracker();
          fromString.feed(wholeDecoder.decode(bytes));
          expect(fromBytes.tail, `${sample.length} bytes at ${at}`).toBe(fromString.tail);
        }
      }
    }
  });
});

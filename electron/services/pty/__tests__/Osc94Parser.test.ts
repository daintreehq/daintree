import { describe, it, expect, vi } from "vitest";
import { Osc94Parser } from "../Osc94Parser.js";

function makeParser() {
  const onWorking = vi.fn();
  const onIdle = vi.fn();
  const parser = new Osc94Parser({ onWorking, onIdle });
  return { parser, onWorking, onIdle };
}

describe("Osc94Parser", () => {
  it("fires onWorking for state=1 with BEL terminator", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("\x1b]9;4;1;50\x07", 100);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(100);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("fires onWorking for state=3 (indeterminate) with no progress field", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]9;4;3\x07", 200);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(200);
  });

  it("fires onIdle for state=0", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("\x1b]9;4;0\x07", 300);
    expect(onIdle).toHaveBeenCalledExactlyOnceWith(300);
    expect(onWorking).not.toHaveBeenCalled();
  });

  it("recognizes ST terminator (ESC \\)", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]9;4;1;25\x1b\\", 400);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(400);
  });

  it("ignores state=2 (error) and state=4 (paused)", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("\x1b]9;4;2\x07", 500);
    parser.feed("\x1b]9;4;4\x07", 510);
    expect(onWorking).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("rejects multi-digit state values (no false positives on malformed input)", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("\x1b]9;4;10\x07", 600);
    parser.feed("\x1b]9;4;\x07", 610);
    parser.feed("\x1b]9;4;x\x07", 620);
    expect(onWorking).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("ignores unrelated OSC sequences (OSC 0 title, OSC 52 clipboard, OSC 9 notification)", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("\x1b]0;Window Title\x07", 700);
    parser.feed("\x1b]52;c;SGVsbG8=\x07", 710);
    parser.feed("\x1b]9;notify\x07", 720);
    expect(onWorking).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("handles a sequence split across two chunks", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]9;4;1;5", 800);
    expect(onWorking).not.toHaveBeenCalled();
    parser.feed("0\x07", 810);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(810);
  });

  it("handles a sequence split between the ESC introducer and the rest", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b", 900);
    parser.feed("]9;4;1;50\x07", 910);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(910);
  });

  it("handles a sequence split right after the OSC introducer (chunk ends in '\\x1b]')", () => {
    // Regression for the fast-guard gap: a chunk ending in the full 2-byte
    // OSC introducer was silently dropped because it satisfied neither
    // `includes("\\x1b]9")` nor `endsWith("\\x1b")`.
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]", 920);
    parser.feed("9;4;1;50\x07", 930);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(930);
  });

  it("recovers a valid OSC 9;4 from inside an unterminated foreign OSC's swallowed payload", () => {
    // Regression for the swallow bug: an unterminated OSC 9 notification
    // accumulates in carry; a later valid OSC 9;4 arrives with its own BEL,
    // which gets misinterpreted as the foreign OSC's terminator and swallows
    // the inner OSC 9;4 as part of the payload. The parser must re-seed carry
    // from the nested `\x1b]` so the inner sequence still fires.
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]9;You have mail", 940);
    expect(onWorking).not.toHaveBeenCalled();
    parser.feed("\x1b]9;4;1;50\x07", 950);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(950);
  });

  it("handles a sequence split inside the ST terminator", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]9;4;1;75\x1b", 1000);
    expect(onWorking).not.toHaveBeenCalled();
    parser.feed("\\", 1010);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(1010);
  });

  it("processes multiple OSC 9;4 sequences in one chunk", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("\x1b]9;4;1;10\x07\x1b]9;4;3\x07\x1b]9;4;0\x07", 1100);
    expect(onWorking).toHaveBeenCalledTimes(2);
    expect(onIdle).toHaveBeenCalledExactlyOnceWith(1100);
  });

  it("processes OSC 9;4 surrounded by plain text and unrelated OSC", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("hello\x1b]9;4;1;42\x07world\x1b]0;Title\x07", 1200);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(1200);
  });

  it("does not allocate or fire when chunk has no OSC marker", () => {
    const { parser, onWorking, onIdle } = makeParser();
    // Plain text — fast guard path. Repeat many times to be sure nothing
    // accumulates in carry.
    for (let i = 0; i < 100; i++) {
      parser.feed("just some output\n", 1300 + i);
    }
    expect(onWorking).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("drops a malformed unterminated sequence past the 600-byte cap", () => {
    const { parser, onWorking, onIdle } = makeParser();
    // Feed an OSC introducer followed by 800 bytes of garbage with no
    // terminator. The carry cap should kick in and discard it without
    // leaking memory.
    parser.feed("\x1b]9;" + "x".repeat(800), 1400);
    expect(onWorking).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
    // After dropping, a fresh valid sequence still parses.
    parser.feed("\x1b]9;4;1;10\x07", 1410);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(1410);
  });

  it("retains trailing ESC across chunks (does not lose split OSC)", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("some output\x1b", 1500);
    parser.feed("]9;4;1;10\x07", 1510);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(1510);
  });

  it("reset() clears the carry buffer", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b]9;4;1;5", 1600);
    parser.reset();
    parser.feed("0\x07", 1610);
    // Without the prior carry, "0\x07" is not a valid OSC sequence.
    expect(onWorking).not.toHaveBeenCalled();
  });

  it("ignores empty chunks", () => {
    const { parser, onWorking, onIdle } = makeParser();
    parser.feed("", 1700);
    parser.feed("\x1b]9;4;1;5", 1710);
    parser.feed("", 1720);
    parser.feed("0\x07", 1730);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(1730);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("handles SGR sequences interleaved with OSC 9;4 without confusion", () => {
    const { parser, onWorking } = makeParser();
    parser.feed("\x1b[31mred\x1b[0m\x1b]9;4;1;50\x07more\x1b[1mbold\x1b[0m", 1800);
    expect(onWorking).toHaveBeenCalledExactlyOnceWith(1800);
  });
});

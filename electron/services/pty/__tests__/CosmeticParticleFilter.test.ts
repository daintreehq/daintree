import { describe, it, expect } from "vitest";
import { isCosmeticParticleCell, stripCosmeticParticles } from "../CosmeticParticleFilter.js";
import { stripIdleTerminalSequences } from "../IdleSequenceFilter.js";
import { isStatusLineRewrite } from "../LineRewriteDetector.js";
import {
  createVisibleCellContentSnapshot,
  measureVisibleContentDelta,
  type VisibleContentCell,
} from "../SustainedChangeTracker.js";

const COLOR_RGB = 0x3000000;
const COLOR_PALETTE_256 = 0x2000000;

// Verbatim head of one synchronized frame captured from codex-cli 0.154.0
// sitting idle at an empty composer (170x40, colour queries answered). The full
// frame is 1.8 KB of the same shape; the animation ran at ~15 fps indefinitely.
const CAPTURED_FRAME_HEAD =
  "\x1b[12;33H\x1b[38;2;105;105;105;48;2;30;30;30m⠁" +
  "\x1b[12;35H\x1b[38;2;109;109;109;48;2;30;30;30m⢀" +
  "\x1b[12;50H\x1b[38;2;38;38;38;48;2;30;30;30m⠐" +
  "\x1b[12;58H\x1b[38;2;102;102;102;48;2;30;30;30m⠐" +
  "\x1b[12;77H\x1b[38;2;105;105;105;48;2;30;30;30m⠄" +
  "\x1b[12;80H\x1b[38;2;39;39;39;48;2;30;30;30m⠈" +
  "\x1b[12;94H\x1b[38;2;117;117;117;48;2;30;30;30m⠠" +
  "\x1b[12;106H\x1b[38;2;73;73;73;48;2;30;30;30m⡀";

// A frame opens by retiring dead particles with erase-to-end-of-line, then
// draws, then closes with this trailer. Nothing in either is work-progress
// evidence — but the erase is a rewrite marker to isStatusLineRewrite, which
// is why the head, not the tail, is the half that can trip that gate.
const CAPTURED_FRAME_ERASE = "\x1b[13;154H\x1b[0m\x1b[48;2;30;30;30m\x1b[K";
const CAPTURED_FRAME_TRAILER =
  "\x1b[39m\x1b[49m\x1b[0m\x1b[11;1H\x1b[0 q\x1b[11;1H \x1b[39m\x1b[49m\x1b[0m\x1b[13;3H";

const CAPTURED_FRAME = `\x1b[?2026h${CAPTURED_FRAME_ERASE}${CAPTURED_FRAME_HEAD}${CAPTURED_FRAME_TRAILER}\x1b[?2026l`;

describe("stripCosmeticParticles", () => {
  it("removes a real captured composer-sparkle frame", () => {
    const stripped = stripCosmeticParticles(CAPTURED_FRAME_HEAD);
    expect(stripped).toBe("");
  });

  it("leaves no braille behind in a full frame", () => {
    expect(stripCosmeticParticles(CAPTURED_FRAME)).not.toMatch(/[⠀-⣿]/u);
  });

  it("removes draws that inherit the previous SGR instead of restating it", () => {
    // Codex omits the colour when the next particle reuses it, so the mop-up
    // pass has to catch a bare cursor-position + glyph.
    // The cursor moves are left in place — they are control bytes that
    // stripAnsi drops downstream; only the glyphs are the filter's business.
    const withInherited = `${CAPTURED_FRAME_HEAD}\x1b[13;130H⠀\x1b[13;151H⠂`;
    expect(stripCosmeticParticles(withInherited)).toBe("\x1b[13;130H\x1b[13;151H");
  });

  it("returns data unchanged below the density gate", () => {
    const single = "\x1b[12;33H\x1b[38;2;105;105;105;48;2;30;30;30m⠁";
    expect(stripCosmeticParticles(single)).toBe(single);
    const two = single + single;
    expect(stripCosmeticParticles(two)).toBe(two);
  });

  it("keeps a braille spinner frame intact", () => {
    // Multi-dot glyph in an accent colour — matches neither half of the rule.
    const spinner = "\r\x1b[K\x1b[38;2;16;163;127m⠹\x1b[0m Working (12s · esc to interrupt)";
    expect(stripCosmeticParticles(spinner)).toBe(spinner);
  });

  it("keeps one-dot braille that is not achromatic", () => {
    const coloured =
      "\x1b[12;33H\x1b[38;2;16;163;127m⠁" +
      "\x1b[12;35H\x1b[38;2;16;163;127m⠂" +
      "\x1b[12;50H\x1b[38;2;16;163;127m⠄";
    expect(stripCosmeticParticles(coloured)).toBe(coloured);
  });

  it("leaves a chromatic one-dot indicator alone even inside a particle chunk", () => {
    // A glyph carrying its own (non-grey) SGR is not an inherited draw; the
    // mop-up pass must not take it just because particles share the chunk.
    const spinner = "\r\x1b[K\x1b[38;2;16;163;127m⠁";
    const chunk = `${CAPTURED_FRAME_HEAD}${spinner}`;
    expect(stripCosmeticParticles(chunk)).toBe(spinner);
    expect(isStatusLineRewrite(chunk)).toBe(true);

    // The same indicator positioned with a cursor move between colour and glyph.
    const moved = "\x1b[38;2;16;163;127m\x1b[4;5H⠁";
    expect(stripCosmeticParticles(`${CAPTURED_FRAME_HEAD}${moved}`)).toBe(moved);
    // 256-colour and 16-colour forms of the same thing.
    const indexed = "\x1b[38;5;205m⠂";
    expect(stripCosmeticParticles(`${CAPTURED_FRAME_HEAD}${indexed}`)).toBe(indexed);
    const red = "\r\x1b[K\x1b[31m⠁";
    expect(stripCosmeticParticles(`${CAPTURED_FRAME_HEAD}${red}`)).toBe(red);
    const brightBold = "\x1b[1;92m⠄";
    expect(stripCosmeticParticles(`${CAPTURED_FRAME_HEAD}${brightBold}`)).toBe(brightBold);
    const colourThenBold = "\r\x1b[K\x1b[31;1m⠁";
    expect(stripCosmeticParticles(`${CAPTURED_FRAME_HEAD}${colourThenBold}`)).toBe(colourThenBold);
  });

  it("does not treat default-foreground or attribute-only SGRs as a colour", () => {
    const chunk = `${CAPTURED_FRAME_HEAD}\x1b[39m⠀\x1b[1m\x1b[13;151H⠂`;
    expect(stripCosmeticParticles(chunk)).toBe("\x1b[39m\x1b[1m\x1b[13;151H");
  });

  it("still mops up an inherited draw that follows a plain SGR reset", () => {
    const chunk = `${CAPTURED_FRAME_HEAD}\x1b[0m\x1b[13;130H⠀\x1b[13;151H⠂`;
    expect(stripCosmeticParticles(chunk)).toBe("\x1b[0m\x1b[13;130H\x1b[13;151H");
  });

  it("preserves real text riding along in a particle frame", () => {
    const mixed = `${CAPTURED_FRAME_HEAD}\x1b[15;1HTask completed successfully`;
    expect(stripCosmeticParticles(mixed)).toBe("\x1b[15;1HTask completed successfully");
  });

  it("returns plain text unchanged", () => {
    expect(stripCosmeticParticles("hello world")).toBe("hello world");
  });
});

describe("particle frames and the activity gates", () => {
  it("counts as zero bytes once idle sequences are stripped", () => {
    const before = Buffer.byteLength(CAPTURED_FRAME, "utf8");
    expect(before).toBeGreaterThan(300);
    // stripAnsi runs downstream of this in ActivityMonitor's byte bucket; what
    // matters is that no printable glyph survives to be counted.
    const stripped = stripIdleTerminalSequences(CAPTURED_FRAME);
    expect(stripped).not.toMatch(/[⠀-⣿]/u);
  });

  it("drops both halves of a sequence split across a node-pty read boundary", () => {
    // Real boundary from the capture: the read ended inside an SGR, so the
    // next chunk opened with parameter bytes stripAnsi cannot recognise and a
    // particle whose colour prefix is in the previous chunk.
    const head = `${CAPTURED_FRAME_HEAD}\x1b[12;108H\x1b[38;2;4`;
    // The unterminated `ESC [ 38;2;4` is gone; the complete CUP before it is
    // not idle noise and is left for stripAnsi downstream.
    expect(stripIdleTerminalSequences(head)).toBe("\x1b[12;108H");

    // A tail that still carries a couple of intact draws clears the density
    // gate with the split one counted, and nothing of the particle field
    // survives — not the orphan parameter bytes, not the glyphs.
    const tail =
      "7;47;47;48;2;30;30;30m⠂" +
      "\x1b[12;110H\x1b[38;2;118;118;118;48;2;30;30;30m⡀" +
      "\x1b[12;125H\x1b[38;2;105;105;105;48;2;30;30;30m⡀" +
      CAPTURED_FRAME_TRAILER;
    expect(stripIdleTerminalSequences(tail)).not.toMatch(/^[0-9;]/u);
    expect(stripIdleTerminalSequences(tail)).not.toMatch(/[⠀-⣿]/u);
    expect(isStatusLineRewrite(tail)).toBe(false);

    // The residual the stateless design accepts: a lone split glyph in a
    // tail with nothing else to corroborate it. Its parameter bytes still go,
    // it is a single code point against the volume bucket, and a real frame
    // tail carries no rewrite marker for the status gate to key on.
    const loneTail = `7;47;47;48;2;30;30;30m⠂${CAPTURED_FRAME_TRAILER}`;
    expect(stripIdleTerminalSequences(loneTail)).not.toMatch(/^[0-9;]/u);
    expect(isStatusLineRewrite(loneTail)).toBe(false);
  });

  it("only touches sequence fragments, never complete sequences or plain text", () => {
    // A complete SGR at either end is not a fragment.
    expect(stripIdleTerminalSequences("Task completed successfully\x1b[0m")).toBe(
      "Task completed successfully\x1b[0m"
    );
    expect(stripIdleTerminalSequences("\x1b[0m$ ")).toBe("\x1b[0m$ ");
    // Prose that happens to start like a parameter tail keeps its digits,
    // whether or not an escape appears later in the chunk.
    expect(stripIdleTerminalSequences("5m ago")).toBe("5m ago");
    expect(stripIdleTerminalSequences("5m ago\x1b[0m")).toBe("5m ago\x1b[0m");
    expect(stripIdleTerminalSequences("42m elapsed\x1b[0m")).toBe("42m elapsed\x1b[0m");
    // A tail that opens with the bracket the ESC left behind is a fragment.
    expect(stripIdleTerminalSequences("[38;2;120;120;120;48;2;30;30;30m\x1b[0m")).toBe("\x1b[0m");
  });

  it("is not classified as a status-line rewrite", () => {
    // Before the filter, the frame's erase-to-EOL plus any braille code point
    // matched STATUS_LINE_PATTERNS, latching an idle agent as spinner-active
    // and suppressing pattern detection on every chunk.
    expect(isStatusLineRewrite(CAPTURED_FRAME)).toBe(false);
  });

  it("still classifies a genuine codex status line as a rewrite", () => {
    const working = "\r\x1b[K• Exploring (12s · esc to interrupt)";
    expect(isStatusLineRewrite(working)).toBe(true);
  });

  it("still classifies a status line that arrives alongside particles", () => {
    const both = `${CAPTURED_FRAME_HEAD}\r\x1b[K• Exploring (12s · esc to interrupt)`;
    expect(isStatusLineRewrite(both)).toBe(true);
  });
});

describe("cell-path density gate", () => {
  const grey = (chars: string, code: number, width = 1): VisibleContentCell => ({
    chars,
    code,
    width,
    fgColorMode: COLOR_RGB,
    fgColor: 0x696969,
    attributes: 0,
  });
  const blank = (): VisibleContentCell => ({
    chars: " ",
    code: 32,
    width: 1,
    fgColorMode: 0,
    fgColor: -1,
    attributes: 0,
  });
  const rowOf = (cells: VisibleContentCell[], cols = 12): VisibleContentCell[] => [
    ...cells,
    ...Array.from({ length: cols - cells.length }, blank),
  ];

  it("keeps a lone grey one-dot glyph as content, so an indicator made of one still ticks", () => {
    const before = createVisibleCellContentSnapshot([rowOf([grey("⠁", 0x2801)])]);
    const after = createVisibleCellContentSnapshot([rowOf([grey("⠂", 0x2802)])]);
    expect(measureVisibleContentDelta(before, after).changed).toBe(true);
  });

  it("drops a particle field, so its shimmer is not a change", () => {
    const field = (glyph: string, code: number) =>
      createVisibleCellContentSnapshot([
        rowOf([grey(glyph, code), blank(), grey(glyph, code), blank(), grey(glyph, code)]),
        rowOf([blank(), grey(glyph, code), blank(), grey(glyph, code)]),
      ]);
    expect(measureVisibleContentDelta(field("⠁", 0x2801), field("⠂", 0x2802)).changed).toBe(false);
  });
});

describe("isCosmeticParticleCell", () => {
  it("matches a one-dot braille cell in achromatic 24-bit grey", () => {
    expect(isCosmeticParticleCell(0x2801, COLOR_RGB, 0x696969)).toBe(true);
    expect(isCosmeticParticleCell(0x2880, COLOR_RGB, 0x262626)).toBe(true);
  });

  it("rejects multi-dot braille", () => {
    expect(isCosmeticParticleCell(0x2839, COLOR_RGB, 0x696969)).toBe(false);
  });

  it("rejects a chromatic foreground", () => {
    expect(isCosmeticParticleCell(0x2801, COLOR_RGB, 0x10a37f)).toBe(false);
  });

  it("rejects palette colours and default foreground", () => {
    expect(isCosmeticParticleCell(0x2801, COLOR_PALETTE_256, 0xf5)).toBe(false);
    expect(isCosmeticParticleCell(0x2801, 0, -1)).toBe(false);
  });

  it("rejects non-braille code points and undefined cells", () => {
    expect(isCosmeticParticleCell(0x2022, COLOR_RGB, 0x696969)).toBe(false);
    expect(isCosmeticParticleCell(undefined, COLOR_RGB, 0x696969)).toBe(false);
  });
});

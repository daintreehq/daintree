// PERF-035 safety proofs for the fused viewport snapshot pipeline.
//
// 1. Parity: the fused single-pass builder inside readVisibleActivitySnapshot
//    must produce the same OBSERVABLE results as the legacy
//    readVisibleActivityCells → createVisibleCellContentSnapshot pipeline.
//    Unit keys/hash/text are internal — the observable contract is
//    measureVisibleContentDelta's (changed, changedChars) across snapshot
//    pairs, which feeds AgentActivityTemperature and every busy/idle
//    decision. The legacy pipeline is reconstructed here verbatim and both
//    are run over the same real xterm buffers.
// 2. ViewportSnapshotCache: identical object until a parse or resize lands,
//    fresh extraction afterward.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IBufferCell, Terminal as HeadlessTerminalType } from "@xterm/headless";
import headless from "@xterm/headless";
const { Terminal: HeadlessTerminal } = headless;
import unicode11 from "@xterm/addon-unicode11";
const { Unicode11Addon } = unicode11;

import {
  readVisibleActivitySnapshot,
  ViewportSnapshotCache,
} from "../analysis/headlessViewport.js";
import {
  createVisibleCellContentSnapshot,
  measureVisibleContentDelta,
  type VisibleContentCell,
  type VisibleContentSnapshot,
} from "../SustainedChangeTracker.js";

function createTerminal(cols = 60, rows = 8): HeadlessTerminalType {
  const term = new HeadlessTerminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
}

function write(term: HeadlessTerminalType, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

function createDefaultCell(chars: string): IBufferCell {
  const code = chars.codePointAt(0)!;
  return {
    getWidth: () => 1,
    getChars: () => chars,
    getCode: () => code,
    isBold: () => false,
    isItalic: () => false,
    isDim: () => false,
    isUnderline: () => false,
    isBlink: () => false,
    isInvisible: () => false,
    isStrikethrough: () => false,
    isOverline: () => false,
    getFgColorMode: () => 0,
    getFgColor: () => -1,
  } as unknown as IBufferCell;
}

function createSingleCellTerminal(chars: string, useRawBuffer: boolean): HeadlessTerminalType {
  const cell = createDefaultCell(chars);
  const code = chars.codePointAt(0)!;
  const line = {
    translateToString: () => chars,
    getCell: () => cell,
    ...(useRawBuffer
      ? {
          _line: {
            _data: new Uint32Array([code | (1 << 22), 0, 0]),
            _combined: {},
            _extendedAttrs: {},
            length: 1,
          },
        }
      : {}),
  };
  return {
    rows: 1,
    cols: 1,
    buffer: {
      active: {
        baseY: 0,
        getNullCell: () => cell,
        getLine: () => line,
      },
    },
  } as unknown as HeadlessTerminalType;
}

// The pre-fusion pipeline, verbatim: full-viewport cell extraction with the
// original per-cell blank checks and 9-bit attribute capture, fed through the
// still-exported createVisibleCellContentSnapshot.
function legacySnapshot(term: HeadlessTerminalType): VisibleContentSnapshot {
  const buffer = term.buffer.active;
  const reusableCell = buffer.getNullCell();
  const rows: VisibleContentCell[][] = [];
  for (let y = buffer.baseY; y < buffer.baseY + term.rows; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const row: VisibleContentCell[] = [];
    for (let x = 0; x < term.cols; x += 1) {
      const cell = line.getCell(x, reusableCell) as IBufferCell | undefined;
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars();
      if (chars.length === 0 || /^\s*$/u.test(chars)) continue;
      row.push({
        chars,
        code: cell.getCode(),
        width,
        fgColorMode: cell.getFgColorMode(),
        fgColor: cell.getFgColor(),
        attributes:
          (cell.isBold() ? 1 : 0) |
          (cell.isItalic() ? 1 << 1 : 0) |
          (cell.isDim() ? 1 << 2 : 0) |
          (cell.isUnderline() ? 1 << 3 : 0) |
          (cell.isBlink() ? 1 << 4 : 0) |
          (cell.isInverse() ? 1 << 5 : 0) |
          (cell.isInvisible() ? 1 << 6 : 0) |
          (cell.isStrikethrough() ? 1 << 7 : 0) |
          (cell.isOverline() ? 1 << 8 : 0),
      });
    }
    rows.push(row);
  }
  return createVisibleCellContentSnapshot(rows);
}

// A progression of buffer states covering the shapes agent terminals render:
// plain text, SGR-styled spinner rewrites, one-char spinner advances, color
// changes, collapsible fill runs, wide CJK + emoji, bold toggles, inverse
// (cursor) toggles, and a full-screen clear to a boxed prompt.
const STATES: Array<{ name: string; data: string }> = [
  { name: "plain-lines", data: "first line\r\nsecond line with words\r\n" },
  {
    name: "spinner-appears",
    data: "\x1b[38;5;215m✶\x1b[0m Deliberating… (esc to interrupt · 1s)",
  },
  {
    name: "spinner-advances",
    data: "\r\x1b[2K\x1b[38;5;215m✻\x1b[0m Deliberating… (esc to interrupt · 2s)",
  },
  {
    name: "color-change",
    data: "\r\x1b[2K\x1b[38;5;33m✻\x1b[0m Deliberating… (esc to interrupt · 2s)",
  },
  { name: "fill-run-short", data: "\r\n──────────\r\n" },
  { name: "fill-run-longer", data: "\x1b[A\r────────────────────\x1b[B\r" },
  { name: "wide-and-emoji", data: "汉字 wide 🚀 emoji\r\n" },
  // "|" is the unit-key separator in the long-key scheme — a default-styled
  // pipe glyph takes the bare-chars fast path and must not collide.
  { name: "pipe-glyphs", data: "a | b | c\r\n" },
  { name: "styled-pipe", data: "\x1b[38;5;99m|\x1b[0m plain |\r\n" },
  { name: "combining-and-astral", data: "café 𝕩 👍🏻\r\n" },
  { name: "bold-toggle", data: "\x1b[1mbold text\x1b[0m\r\n" },
  { name: "inverse-only", data: "\x1b[7minverse block\x1b[0m\r\n" },
  {
    name: "clear-to-prompt",
    data: "\x1b[2J\x1b[H╭────────────────────╮\r\n│ > \x1b[7m \x1b[0m              │\r\n╰────────────────────╯\r\n  ? for shortcuts\r\n",
  },
];

describe("fused viewport snapshot parity (PERF-035)", () => {
  let term: HeadlessTerminalType;

  beforeEach(() => {
    term = createTerminal();
  });

  afterEach(() => {
    term.dispose();
  });

  it("produces the same delta sequence as the legacy pipeline across realistic buffer states", async () => {
    let previousLegacy = legacySnapshot(term);
    let previousFused = readVisibleActivitySnapshot(term, 15)!;

    for (const state of STATES) {
      await write(term, state.data);
      const legacy = legacySnapshot(term);
      const fused = readVisibleActivitySnapshot(term, 15)!;

      const legacyDelta = measureVisibleContentDelta(previousLegacy, legacy);
      const fusedDelta = measureVisibleContentDelta(previousFused, fused);

      expect(fusedDelta, `state "${state.name}"`).toEqual(legacyDelta);

      previousLegacy = legacy;
      previousFused = fused;
    }
  });

  it("reports no change when the buffer is re-extracted without new writes", async () => {
    await write(term, "stable content\r\n✶ working (esc to interrupt)");
    const first = readVisibleActivitySnapshot(term, 15)!;
    const second = readVisibleActivitySnapshot(term, 15)!;
    expect(measureVisibleContentDelta(first, second)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it.each(["h", "𝕩", "─"])(
    "keeps the same unit key for raw and public-cell extraction of %s",
    (chars) => {
      const raw = readVisibleActivitySnapshot(createSingleCellTerminal(chars, true), 1)!;
      const fallback = readVisibleActivitySnapshot(createSingleCellTerminal(chars, false), 1)!;

      expect(fallback.units).toEqual(raw.units);
      expect(measureVisibleContentDelta(raw, fallback)).toEqual({
        changed: false,
        changedChars: 0,
      });
    }
  );

  it("masks the inverse attribute like the legacy key scheme (cursor toggles are not changes)", async () => {
    await write(term, "prompt ready > ");
    const before = readVisibleActivitySnapshot(term, 15)!;
    // Rewrite the same text with inverse video on the trailing cell (block
    // cursor) — foregroundContentAttributes masked this out of legacy keys.
    await write(term, "\r\x1b[2Kprompt ready \x1b[7m>\x1b[0m ");
    const after = readVisibleActivitySnapshot(term, 15)!;
    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("collapses repeated fill characters across cells like the legacy scheme", async () => {
    await write(term, "──────────");
    const short = readVisibleActivitySnapshot(term, 15)!;
    await write(term, "──────────");
    const longer = readVisibleActivitySnapshot(term, 15)!;
    // A pure fill-run growth collapses to a single unit in both schemes.
    expect(measureVisibleContentDelta(short, longer)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });
});

describe("ViewportSnapshotCache (PERF-035)", () => {
  let term: HeadlessTerminalType;
  let cache: ViewportSnapshotCache;

  beforeEach(() => {
    term = createTerminal();
    cache = new ViewportSnapshotCache();
    cache.attach(term);
  });

  afterEach(() => {
    cache.detach();
    term.dispose();
  });

  it("returns the identical snapshot object while nothing has parsed", async () => {
    await write(term, "hello world");
    const first = cache.read(term, 15);
    const second = cache.read(term, 15);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("re-extracts after a parse lands", async () => {
    await write(term, "hello world");
    const first = cache.read(term, 15);
    await write(term, " — more");
    const second = cache.read(term, 15);
    expect(second).not.toBe(first);
    expect(measureVisibleContentDelta(first, second!).changed).toBe(true);
  });

  it("re-extracts after an explicit invalidate (write-callback ordering path)", async () => {
    await write(term, "hello world");
    const first = cache.read(term, 15);
    cache.invalidate();
    const second = cache.read(term, 15);
    expect(second).not.toBe(first);
    // Content unchanged — the fresh extraction still diffs as no change.
    expect(measureVisibleContentDelta(first!, second!)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("re-extracts after a resize", async () => {
    await write(term, "hello world");
    const first = cache.read(term, 15);
    term.resize(50, 8);
    const second = cache.read(term, 15);
    expect(second).not.toBe(first);
  });

  it("keys the cache on the requested line count", async () => {
    await write(term, "hello world");
    cache.read(term, 15);
    const six = cache.read(term, 6);
    expect(six).toBeDefined();
    // Same generation, same n — served from cache.
    expect(cache.read(term, 6)).toBe(six);
    // Same generation, different n — must re-extract, not serve the n=6 object.
    expect(cache.read(term, 15)).not.toBe(six);
  });

  it("preserves the legacy delta sequence while unchanged raw rows are reused", async () => {
    let previousLegacy = legacySnapshot(term);
    let previousCached = cache.read(term, 15)!;

    for (const state of STATES) {
      await write(term, state.data);
      const legacy = legacySnapshot(term);
      const cached = cache.read(term, 15)!;

      expect(measureVisibleContentDelta(previousCached, cached), `state "${state.name}"`).toEqual(
        measureVisibleContentDelta(previousLegacy, legacy)
      );

      previousLegacy = legacy;
      previousCached = cached;
    }
  });
});

import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { ITheme } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  buildGridRemainderBackground,
  buildPaddingBackgroundStyle,
  createPaddingPaintSampler,
  NO_PADDING_PAINT,
  paddingPaintEquals,
  parseOpaqueColor,
  resolvePaletteColor,
  type TerminalPaddingPaint,
} from "../terminalPaddingPaint";

const COLS = 10;
const ROWS = 4;

function makeTerminal(theme?: ITheme) {
  const terminal = new HeadlessTerminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 50,
    allowProposedApi: true,
  });
  if (theme) (terminal.options as { theme?: ITheme }).theme = theme;
  return terminal;
}

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

const sample = (terminal: HeadlessTerminal) => createPaddingPaintSampler()(terminal);

/** Paints every visible row edge to edge with the given SGR background. */
function paintedScreen(sgr: string, rows = ROWS): string {
  const row = `\x1b[${sgr}m${" ".repeat(COLS)}\x1b[0m`;
  return Array.from({ length: rows }, (_, i) => `\x1b[${i + 1};1H${row}`).join("");
}

describe("padding paint sampler (#13160)", () => {
  it("extends every side of a TUI that paints a truecolor background", async () => {
    const terminal = makeTerminal();
    await write(terminal, paintedScreen("48;2;20;20;20"));

    const paint = sample(terminal);
    expect(paint).toMatchObject({
      top: "#141414",
      right: "#141414",
      bottom: "#141414",
      left: "#141414",
    });
    terminal.dispose();
  });

  it("leaves a plain shell on the theme background", async () => {
    const terminal = makeTerminal();
    await write(terminal, "$ ls\r\nfile-a  file-b\r\n$ ");

    expect(sample(terminal)).toBe(NO_PADDING_PAINT);
    terminal.dispose();
  });

  it("refuses an edge row with any default-background cell", async () => {
    const terminal = makeTerminal();
    await write(terminal, paintedScreen("48;2;20;20;20"));
    // A shell prompt on the bottom row: mostly default background.
    await write(terminal, `\x1b[${ROWS};1H\x1b[2K$ `);

    const paint = sample(terminal);
    expect(paint.top).toBe("#141414");
    expect(paint.bottom).toBeNull();
    // The prompt row breaks the left and right columns too.
    expect(paint.left).toBeNull();
    expect(paint.right).toBeNull();
    terminal.dispose();
  });

  it("takes the dominant colour of a fully painted edge", async () => {
    const terminal = makeTerminal();
    await write(terminal, paintedScreen("48;2;20;20;20"));
    // A narrow inset of another shade along the top row.
    await write(terminal, "\x1b[1;4H\x1b[48;2;25;25;25m   \x1b[0m");

    expect(sample(terminal).top).toBe("#141414");
    terminal.dispose();
  });

  it("resolves palette backgrounds through the theme and the 256-colour cube", async () => {
    const terminal = makeTerminal({ blue: "#1e66f5" });
    await write(terminal, paintedScreen("44"));
    expect(sample(terminal).top).toBe("#1e66f5");

    await write(terminal, paintedScreen("48;5;196"));
    expect(sample(terminal).top).toBe("#ff0000");
    terminal.dispose();
  });

  it("treats an inverse cell's foreground as its background, but not the default one", async () => {
    const terminal = makeTerminal();
    await write(terminal, paintedScreen("7;38;2;30;30;46"));
    expect(sample(terminal).top).toBe("#1e1e2e");

    await write(terminal, paintedScreen("7"));
    expect(sample(terminal)).toBe(NO_PADDING_PAINT);
    terminal.dispose();
  });

  it("returns to the theme background when the app resets the screen", async () => {
    const terminal = makeTerminal();
    const sampler = createPaddingPaintSampler();
    await write(terminal, paintedScreen("48;2;20;20;20"));
    expect(sampler(terminal).top).toBe("#141414");

    await write(terminal, "\x1b[0m\x1b[2J\x1b[H$ ");
    expect(sampler(terminal)).toBe(NO_PADDING_PAINT);
    terminal.dispose();
  });

  it("never extends from the alternate buffer", async () => {
    const terminal = makeTerminal();
    await write(terminal, "\x1b[?1049h");
    await write(terminal, paintedScreen("48;2;20;20;20"));

    expect(terminal.buffer.active.type).toBe("alternate");
    expect(sample(terminal)).toBe(NO_PADDING_PAINT);
    terminal.dispose();
  });

  it("samples the rows in view when scrolled back", async () => {
    const terminal = makeTerminal();
    await write(terminal, paintedScreen("48;2;20;20;20"));
    await write(terminal, `\x1b[${ROWS};1H` + "\r\n".repeat(ROWS) + "$ ");
    expect(sample(terminal)).toBe(NO_PADDING_PAINT);

    terminal.scrollToTop();
    expect(sample(terminal).top).toBe("#141414");
    terminal.dispose();
  });
});

describe("padding paint colour resolution", () => {
  it("parses opaque theme colours and rejects translucent ones", () => {
    expect(parseOpaqueColor("#abc")).toBe(0xaabbcc);
    expect(parseOpaqueColor("#abcf")).toBe(0xaabbcc);
    expect(parseOpaqueColor("#abc8")).toBeNull();
    expect(parseOpaqueColor("#141414")).toBe(0x141414);
    expect(parseOpaqueColor("#141414ff")).toBe(0x141414);
    expect(parseOpaqueColor("#14141480")).toBeNull();
    expect(parseOpaqueColor("rgb(20, 20, 20)")).toBe(0x141414);
    expect(parseOpaqueColor("rgba(20, 20, 20, 0.5)")).toBeNull();
    expect(parseOpaqueColor("var(--theme-surface-canvas)")).toBeNull();
    expect(parseOpaqueColor(undefined)).toBeNull();
  });

  it("resolves the extended palette with theme overrides first", () => {
    expect(resolvePaletteColor(16, undefined)).toBe(0x000000);
    expect(resolvePaletteColor(231, undefined)).toBe(0xffffff);
    expect(resolvePaletteColor(232, undefined)).toBe(0x080808);
    expect(resolvePaletteColor(255, undefined)).toBe(0xeeeeee);
    expect(resolvePaletteColor(16, { extendedAnsi: ["#101010"] })).toBe(0x101010);
    expect(resolvePaletteColor(1, {})).toBeNull();
  });
});

describe("padding paint styles", () => {
  const paint: TerminalPaddingPaint = {
    top: "#141414",
    right: null,
    bottom: "#191919",
    left: "#141414",
    gridWidth: 720,
    gridHeight: 408,
  };

  it("compares every field", () => {
    expect(paddingPaintEquals(paint, { ...paint })).toBe(true);
    const changes: Partial<TerminalPaddingPaint>[] = [
      { top: null },
      { right: "#141414" },
      { bottom: "#141414" },
      { left: null },
      { gridWidth: 711 },
      { gridHeight: 390 },
    ];
    for (const change of changes) {
      expect(paddingPaintEquals(paint, { ...paint, ...change })).toBe(false);
    }
  });

  it("layers top and bottom over the side strips", () => {
    const style = buildPaddingBackgroundStyle(paint)!;
    expect(style.backgroundImage).toBe(
      "linear-gradient(#141414, #141414), linear-gradient(#191919, #191919), linear-gradient(#141414, #141414)"
    );
    expect(style.backgroundRepeat).toBe("no-repeat");
    expect(buildPaddingBackgroundStyle(NO_PADDING_PAINT)).toBeNull();
  });

  it("starts the bottom strip at the grid's bottom edge so the fit remainder is covered", () => {
    const [, bottom] = buildPaddingBackgroundStyle(paint)!.backgroundPosition.split(", ");
    expect(bottom).toContain(`${paint.gridHeight}px`);

    // Grid size unknown: fall back to a padding-high strip at the bottom.
    const unsized = buildPaddingBackgroundStyle({ ...paint, gridWidth: 0, gridHeight: 0 })!;
    expect(unsized.backgroundPosition.split(", ")[1]).toBe("bottom left");
  });

  it("paints the right grid remainder past the canvas", () => {
    const right = { ...paint, right: "#202020" };
    expect(buildGridRemainderBackground(right)).toEqual({
      image: "linear-gradient(#202020, #202020)",
      position: "720px 0",
      size: "100% 100%",
    });
    expect(buildGridRemainderBackground(paint)).toBeNull();
    expect(buildGridRemainderBackground({ ...right, gridWidth: 0 })).toBeNull();
  });
});

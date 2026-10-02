import type { IBuffer, IBufferCell, IBufferLine, ITheme } from "@xterm/xterm";

/**
 * The colour each side of a normal-buffer terminal's padding should take so a
 * TUI that paints its own background reads edge to edge (#13160), modelled on
 * Ghostty's `window-padding-color = extend`. A null side keeps the theme
 * background. `gridWidth`/`gridHeight` are the rendered grid's CSS size, so the
 * strip the whole-cell fit leaves beyond the last cell can be painted to match.
 */
export interface TerminalPaddingPaint {
  top: string | null;
  right: string | null;
  bottom: string | null;
  left: string | null;
  gridWidth: number;
  gridHeight: number;
}

export const NO_PADDING_PAINT: TerminalPaddingPaint = Object.freeze({
  top: null,
  right: null,
  bottom: null,
  left: null,
  gridWidth: 0,
  gridHeight: 0,
});

export function paddingPaintEquals(a: TerminalPaddingPaint, b: TerminalPaddingPaint): boolean {
  return (
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.gridWidth === b.gridWidth &&
    a.gridHeight === b.gridHeight
  );
}

export function hasPaddingPaint(paint: TerminalPaddingPaint): boolean {
  return paint.top !== null || paint.right !== null || paint.bottom !== null || paint.left !== null;
}

const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies ReadonlyArray<keyof ITheme>;

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/** Parses an opaque CSS colour from a theme into 0xRRGGBB; null if translucent or unparseable. */
export function parseOpaqueColor(css: string | undefined): number | null {
  if (!css) return null;
  const value = css.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    const digits = hex.length <= 4 ? hex.replace(/./g, "$&$&") : hex;
    if (digits.length === 8 && digits.slice(6).toLowerCase() !== "ff") return null;
    return parseInt(digits.slice(0, 6), 16);
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (rgb) {
    const [, r = "", g = "", b = "", alpha] = rgb;
    if (alpha !== undefined && Number(alpha) < 1) return null;
    return packRgb(Number(r), Number(g), Number(b));
  }
  return null;
}

function packRgb(r: number, g: number, b: number): number {
  return (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, b);
}

/**
 * Resolves a 256-colour palette index against the configured theme; null when
 * the theme can't say. Live OSC 4 palette overrides aren't visible here, so an
 * app that redefines a palette slot extends the configured colour instead.
 */
export function resolvePaletteColor(index: number, theme: ITheme | undefined): number | null {
  if (index < 16) {
    const key = ANSI_THEME_KEYS[index];
    return key ? parseOpaqueColor(theme?.[key]) : null;
  }
  const extended = theme?.extendedAnsi?.[index - 16];
  if (extended !== undefined) return parseOpaqueColor(extended);
  if (index < 232) {
    const offset = index - 16;
    const step = (n: number) => CUBE_STEPS[n % 6] ?? 0;
    return packRgb(step(Math.floor(offset / 36)), step(Math.floor(offset / 6)), step(offset));
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return packRgb(level, level, level);
  }
  return null;
}

/**
 * The background a cell visibly shows when the app painted it explicitly, or
 * null when it shows the terminal default. Inverse cells show their foreground,
 * and an inverse cell with the default foreground counts as unpainted — that is
 * the theme colour, not one the app chose.
 */
function explicitBackground(cell: IBufferCell, theme: ITheme | undefined): number | null {
  if (cell.isInverse()) {
    if (cell.isFgRGB()) return cell.getFgColor();
    if (cell.isFgPalette()) return resolvePaletteColor(cell.getFgColor(), theme);
    return null;
  }
  if (cell.isBgRGB()) return cell.getBgColor();
  if (cell.isBgPalette()) return resolvePaletteColor(cell.getBgColor(), theme);
  return null;
}

/**
 * Tallies one edge. Any cell without an explicit background disqualifies the
 * whole edge (Ghostty's guard: a row with default-background cells — a shell
 * prompt, ordinary output — must never extend). Otherwise the edge takes its
 * dominant colour, so a body colour wins over a narrow inset of another shade.
 */
class EdgeTally {
  private readonly counts = new Map<number, number>();
  private disqualified = false;

  reset(): void {
    this.counts.clear();
    this.disqualified = false;
  }

  get done(): boolean {
    return this.disqualified;
  }

  add(color: number | null): void {
    if (this.disqualified) return;
    if (color === null) {
      this.disqualified = true;
      this.counts.clear();
      return;
    }
    this.counts.set(color, (this.counts.get(color) ?? 0) + 1);
  }

  result(): string | null {
    if (this.disqualified) return null;
    let best: number | null = null;
    let bestCount = 0;
    for (const [color, count] of this.counts) {
      if (count > bestCount) {
        best = color;
        bestCount = count;
      }
    }
    return best === null ? null : `#${best.toString(16).padStart(6, "0")}`;
  }
}

/** The slice of an xterm `Terminal` the sampler reads; the headless build satisfies it too. */
export interface PaddingPaintSource {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: Pick<IBuffer, "type" | "viewportY" | "getLine" | "getNullCell">;
  };
  readonly options: { readonly theme?: ITheme };
  readonly dimensions?: { readonly css: { readonly canvas: { width: number; height: number } } };
}

/**
 * A reusable sampler for one terminal. Reads only the visible perimeter —
 * O(cols + rows) cell reads with a reused cell, and a default-background edge
 * bails on its first cell, so a plain shell costs a handful of reads.
 */
export function createPaddingPaintSampler(): (
  terminal: PaddingPaintSource
) => TerminalPaddingPaint {
  let cell: IBufferCell | undefined;
  const top = new EdgeTally();
  const bottom = new EdgeTally();
  const left = new EdgeTally();
  const right = new EdgeTally();

  const scanRow = (
    line: IBufferLine | undefined,
    cols: number,
    tally: EdgeTally,
    theme?: ITheme
  ) => {
    if (!line || !cell) return tally.add(null);
    for (let x = 0; x < cols && !tally.done; x++) {
      tally.add(line.getCell(x, cell) ? explicitBackground(cell, theme) : null);
    }
  };

  return (terminal) => {
    const buffer = terminal.buffer.active;
    if (buffer.type === "alternate") return NO_PADDING_PAINT;
    const { cols, rows } = terminal;
    if (cols <= 0 || rows <= 0) return NO_PADDING_PAINT;

    cell ??= buffer.getNullCell();
    const theme = terminal.options.theme;
    const viewportY = buffer.viewportY;
    top.reset();
    bottom.reset();
    left.reset();
    right.reset();

    scanRow(buffer.getLine(viewportY), cols, top, theme);
    scanRow(buffer.getLine(viewportY + rows - 1), cols, bottom, theme);
    for (let y = 0; y < rows && !(left.done && right.done); y++) {
      const line = buffer.getLine(viewportY + y);
      if (!line) {
        left.add(null);
        right.add(null);
        break;
      }
      if (!left.done) left.add(line.getCell(0, cell) ? explicitBackground(cell, theme) : null);
      if (!right.done) {
        right.add(line.getCell(cols - 1, cell) ? explicitBackground(cell, theme) : null);
      }
    }

    const paint: TerminalPaddingPaint = {
      top: top.result(),
      right: right.result(),
      bottom: bottom.result(),
      left: left.result(),
      gridWidth: 0,
      gridHeight: 0,
    };
    if (!hasPaddingPaint(paint)) return NO_PADDING_PAINT;
    const canvas = terminal.dimensions?.css.canvas;
    paint.gridWidth = Math.round(canvas?.width ?? 0);
    paint.gridHeight = Math.round(canvas?.height ?? 0);
    return paint;
  };
}

// The wrapper's `pl-3 pt-3 pb-3 pr-3` gutter in XtermAdapter (3 × Tailwind's 0.25rem spacing).
const PADDING = "0.75rem";

const solid = (color: string) => `linear-gradient(${color}, ${color})`;

export type PaddingBackgroundStyle = Record<
  "backgroundImage" | "backgroundPosition" | "backgroundSize" | "backgroundRepeat",
  string
>;

/**
 * Background layers for the padded wrapper. Top and bottom strips span the full
 * width and own the corners; left and right fill only between them, so an
 * unextended top or bottom keeps square theme-coloured corners. xterm's root is
 * only as tall as the grid, so the wrapper also shows through below it — the
 * bottom strip starts at the grid's bottom edge when that is known.
 */
export function buildPaddingBackgroundStyle(
  paint: TerminalPaddingPaint
): PaddingBackgroundStyle | null {
  const images: string[] = [];
  const positions: string[] = [];
  const sizes: string[] = [];
  if (paint.top) {
    images.push(solid(paint.top));
    positions.push("top left");
    sizes.push(`100% ${PADDING}`);
  }
  if (paint.bottom) {
    images.push(solid(paint.bottom));
    if (paint.gridHeight > 0) {
      positions.push(`left 0 top calc(${PADDING} + ${paint.gridHeight}px)`);
      sizes.push("100% 100%");
    } else {
      positions.push("bottom left");
      sizes.push(`100% ${PADDING}`);
    }
  }
  if (paint.left) {
    images.push(solid(paint.left));
    positions.push("left center");
    sizes.push(`${PADDING} calc(100% - 2 * ${PADDING})`);
  }
  if (paint.right) {
    images.push(solid(paint.right));
    positions.push("right center");
    sizes.push(`${PADDING} calc(100% - 2 * ${PADDING})`);
  }
  if (images.length === 0) return null;
  return {
    backgroundImage: images.join(", "),
    backgroundPosition: positions.join(", "),
    backgroundSize: sizes.join(", "),
    backgroundRepeat: "no-repeat",
  };
}

/**
 * Background layer for xterm's scrollable element, which spans the host's full
 * width at the grid's height and carries an inline theme background. The grid
 * is fitted in whole cells, so up to a cell of it shows right of the canvas —
 * paint that with the right colour so the extension has no seam. (Below the
 * grid the wrapper shows through; `buildPaddingBackgroundStyle` covers it.)
 */
export function buildGridRemainderBackground(paint: TerminalPaddingPaint): {
  image: string;
  position: string;
  size: string;
} | null {
  if (!paint.right || paint.gridWidth <= 0) return null;
  return { image: solid(paint.right), position: `${paint.gridWidth}px 0`, size: "100% 100%" };
}

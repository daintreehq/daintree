// The terminal half of ANSI output that a log view needs: SGR colours and
// styles, the line a carriage return or `\x1b[K` rewrites, cursor moves
// within the output, and OSC 8 hyperlinks. Colours resolve to the theme's
// `terminal-*` tokens, so output reads exactly as it does in a Daintree
// terminal.
//
// The output is the plugin's, and often a third party's (a CLI it ran), so
// the parser is bounded everywhere: escapes, parameters, links, line length,
// runs per line and lines kept all have caps, a malformed escape gives way to
// the text after it, and nothing grows with input it then throws away. SGR is
// read here rather than by Anser (which the host's HTML export uses): Anser
// keeps duplicate decorations, so `\x1b[1m\x1b[1mA\x1b[22mB` stays bold, and
// its state grows with every repeat.

export interface AnsiStyle {
  /** A CSS colour, or null for the surface's default ink. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  hidden: boolean;
  /** The OSC 8 target the text links to. */
  link: string | null;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

/** One line of output, as published: never changed afterwards. */
export interface AnsiLine {
  readonly segments: readonly AnsiSegment[];
  readonly length: number;
}

/** What a parser has drawn: the lines kept, and how many older ones were dropped. */
export interface AnsiSnapshot {
  readonly lines: readonly AnsiLine[];
  readonly dropped: number;
}

export const PLAIN_STYLE: AnsiStyle = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
  hidden: false,
  link: null,
});

const EMPTY_LINE: AnsiLine = Object.freeze({ segments: Object.freeze([]), length: 0 });

/** Characters a line keeps; the rest of a longer line is cut. */
export const MAX_LINE_CHARS = 16_384;
/** Differently styled runs a line keeps; past it, text takes the last run's style. */
export const MAX_LINE_RUNS = 512;
/** Bytes of a CSI sequence's parameters; a longer one is dropped whole. */
const MAX_CSI_CHARS = 256;
/** Bytes of an OSC payload; a longer one is dropped whole (its text stays hidden). */
const MAX_OSC_CHARS = 4096;
/** Characters of an OSC 8 link target. */
const MAX_LINK_CHARS = 2048;

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

// xterm's own defaults, for a theme that drops an extended token.
const FALLBACK: Record<string, string> = {
  black: "#2e3436",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  "bright-black": "#666666",
  "bright-red": "#f14c4c",
  "bright-green": "#23d18b",
  "bright-yellow": "#f5f543",
  "bright-blue": "#3b8eea",
  "bright-magenta": "#d670d6",
  "bright-cyan": "#29b8db",
  "bright-white": "#ffffff",
};

/** The default ink and surface a reversed run swaps in. */
export const TERMINAL_FOREGROUND = "var(--theme-terminal-foreground, var(--theme-text-primary))";
export const TERMINAL_BACKGROUND = "var(--theme-terminal-background, var(--theme-surface-canvas))";

function token(name: string): string {
  return `var(--theme-terminal-${name}, ${FALLBACK[name]})`;
}

const LEVELS = [0, 95, 135, 175, 215, 255];

/** The xterm 256-colour palette entry `index` as a CSS colour; 0–15 are the theme's. */
export function paletteColor(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return token(`${index >= 8 ? "bright-" : ""}${NAMES[index % 8]}`);
  if (index < 232) {
    const n = index - 16;
    return `rgb(${LEVELS[Math.floor(n / 36)]}, ${LEVELS[Math.floor(n / 6) % 6]}, ${LEVELS[n % 6]})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

/** A colour as SGR sets it: a palette index, or an `rgb()` string. */
type Ink = number | string | null;

interface Pen {
  fg: Ink;
  bg: Ink;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  hidden: boolean;
}

const PLAIN_PEN: Pen = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
  hidden: false,
};

function inkColor(ink: Ink, bold: boolean): string | null {
  if (ink === null || typeof ink === "string") return ink;
  // xterm draws bold text in the bright colours (drawBoldTextInBrightColors).
  return paletteColor(bold && ink < 8 ? ink + 8 : ink);
}

/** A number SGR or a cursor move may carry: plain digits, at most five of them. */
function param(text: string | undefined): number | null {
  if (text === undefined || text === "") return null;
  return /^\d{1,5}$/.test(text) ? Number(text) : NaN;
}

/**
 * An extended colour (`38`/`48`) from its arguments: `5;n` or `2;r;g;b`, as
 * semicolon parameters or colon sub-parameters (`38:2::r:g:b`, `38:2:r:g:b`).
 * Returns the colour (undefined when malformed) and how many semicolon
 * parameters it used.
 */
function extendedInk(
  sub: readonly string[],
  rest: readonly string[]
): { ink: Ink | undefined; used: number } {
  const channel = (value: string | undefined) => {
    const n = param(value);
    return n !== null && n >= 0 && n <= 255 ? n : undefined;
  };
  if (sub.length > 1) {
    if (sub[1] === "5") {
      const n = channel(sub[2]);
      return { ink: n, used: 0 };
    }
    if (sub[1] === "2") {
      const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
      const [r, g, b] = rgb.map(channel);
      return {
        ink:
          r !== undefined && g !== undefined && b !== undefined
            ? `rgb(${r}, ${g}, ${b})`
            : undefined,
        used: 0,
      };
    }
    return { ink: undefined, used: 0 };
  }
  if (rest[0] === "5") return { ink: channel(rest[1]), used: 2 };
  if (rest[0] === "2") {
    const [r, g, b] = rest.slice(1, 4).map(channel);
    return {
      ink:
        r !== undefined && g !== undefined && b !== undefined ? `rgb(${r}, ${g}, ${b})` : undefined,
      used: 4,
    };
  }
  return { ink: undefined, used: rest.length > 0 ? 1 : 0 };
}

/** The pen after an SGR sequence's parameters. Exported for tests. */
export function applySgr(pen: Pen, params: string): Pen {
  const next = { ...pen };
  const groups = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < groups.length; i++) {
    const sub = groups[i]!.split(":");
    const code = param(sub[0]) ?? 0;
    if (Number.isNaN(code)) continue;
    if (code === 38 || code === 48 || code === 58) {
      const { ink, used } = extendedInk(sub, groups.slice(i + 1, i + 5));
      i += used;
      if (ink === undefined || code === 58) continue;
      if (code === 38) next.fg = ink;
      else next.bg = ink;
      continue;
    }
    if (code === 0) Object.assign(next, PLAIN_PEN);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = sub[1] !== "0";
    else if (code === 7) next.inverse = true;
    else if (code === 8) next.hidden = true;
    else if (code === 9) next.strike = true;
    else if (code === 21) next.underline = true;
    else if (code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 28) next.hidden = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
  }
  return next;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.link === b.link
  );
}

function styleOf(pen: Pen, link: string | null): AnsiStyle {
  const style: AnsiStyle = {
    fg: inkColor(pen.fg, pen.bold),
    bg: inkColor(pen.bg, false),
    bold: pen.bold,
    dim: pen.dim,
    italic: pen.italic,
    underline: pen.underline,
    strike: pen.strike,
    inverse: pen.inverse,
    hidden: pen.hidden,
    link,
  };
  return sameStyle(style, PLAIN_STYLE) ? PLAIN_STYLE : style;
}

/** A line being written: changed in place, published as an {@link AnsiLine} copy. */
interface WorkLine {
  segments: AnsiSegment[];
  length: number;
}

function sliceSegments(segments: readonly AnsiSegment[], from: number, to: number): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let at = 0;
  for (const segment of segments) {
    const end = at + segment.text.length;
    if (end > from && at < to) {
      out.push({
        text: segment.text.slice(Math.max(0, from - at), Math.min(segment.text.length, to - at)),
        style: segment.style,
      });
    }
    at = end;
    if (at >= to) break;
  }
  return out;
}

function pushSegment(segments: AnsiSegment[], text: string, style: AnsiStyle): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  // Past the run cap, text joins the last run: a line of alternating colours
  // stays one bounded row rather than a hundred thousand spans.
  if (last && (last.style === style || segments.length >= MAX_LINE_RUNS)) {
    segments[segments.length - 1] = { text: last.text + text, style: last.style };
  } else segments.push({ text, style });
}

function codeUnitAt(line: WorkLine, index: number): number {
  if (index < 0) return -1;
  let at = 0;
  for (const segment of line.segments) {
    if (index < at + segment.text.length) return segment.text.charCodeAt(index - at);
    at += segment.text.length;
  }
  return -1;
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Writes `text` over `line` from column `col`, as a terminal draws it. */
function writeAt(line: WorkLine, col: number, text: string, style: AnsiStyle): void {
  if (col >= line.length) {
    if (col > line.length) pushSegment(line.segments, " ".repeat(col - line.length), PLAIN_STYLE);
    pushSegment(line.segments, text, style);
    line.length = col + text.length;
    return;
  }
  // Overwriting half of a surrogate pair blanks the other half, as a terminal
  // does to a wide character, rather than leaving an orphan code unit.
  let end = col + text.length;
  if (isLow(codeUnitAt(line, end)) && isHigh(codeUnitAt(line, end - 1))) {
    text = `${text} `;
    end++;
  }
  if (isLow(codeUnitAt(line, col)) && isHigh(codeUnitAt(line, col - 1))) {
    col--;
    text = ` ${text}`;
  }
  const segments: AnsiSegment[] = [];
  for (const segment of sliceSegments(line.segments, 0, col)) {
    pushSegment(segments, segment.text, segment.style);
  }
  pushSegment(segments, text, style);
  for (const segment of sliceSegments(line.segments, end, line.length)) {
    pushSegment(segments, segment.text, segment.style);
  }
  line.segments = segments;
  line.length = Math.max(line.length, end);
}

/** The line's text without its styles. */
export function lineText(line: AnsiLine): string {
  return line.segments.map((segment) => segment.text).join("");
}

const State = {
  Ground: 0,
  Escape: 1,
  Csi: 2,
  Osc: 3,
  /** DCS, SOS, PM and APC: a string to consume and ignore. */
  Text: 4,
  /** ESC inside an OSC or a control string: ST, or the end of it. */
  StringEscape: 5,
  /** A charset designation's one final byte. */
  Charset: 6,
} as const;
type State = (typeof State)[keyof typeof State];

/** The control a C1 byte stands for, as its 7-bit escape's second byte. */
const C1: Record<number, string> = {
  0x90: "P",
  0x98: "X",
  0x9b: "[",
  0x9c: "\\",
  0x9d: "]",
  0x9e: "^",
  0x9f: "_",
};

/**
 * Parses output as it arrives. `write` takes the next chunk; an escape split
 * across chunks carries over, and every buffer it holds is bounded.
 * `snapshot()` is what to draw: immutable, so an earlier snapshot never
 * changes under a later write.
 */
export class AnsiParser {
  private readonly maxLines: number;
  private pen: Pen = PLAIN_PEN;
  private link: string | null = null;
  private style: AnsiStyle = PLAIN_STYLE;
  private state: State = State.Ground;
  private buffer = "";
  private overflow = false;
  /** Whether the string being consumed is an OSC (read) or another control string (ignored). */
  private stringIsOsc = false;
  /** Lines, oldest first; `rows[head]` is the oldest kept. */
  private rows: WorkLine[] = [{ segments: [], length: 0 }];
  private published: AnsiLine[] = [EMPTY_LINE];
  private head = 0;
  /** Rows removed from the front of `rows` by compaction. */
  private base = 0;
  /** The cursor's row, counted from the first line ever written. */
  private row = 0;
  private col = 0;
  private dirty = new Set<number>();
  private cached: AnsiSnapshot | null = null;

  constructor(maxLines = Infinity) {
    this.maxLines = Math.max(1, maxLines);
  }

  write(chunk: string): void {
    if (chunk === "") return;
    this.cached = null;
    let textStart = -1;
    const flush = (end: number) => {
      if (textStart !== -1 && end > textStart) this.text(chunk.slice(textStart, end));
      textStart = -1;
    };
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (this.state === State.Ground) {
        const printable = (code >= 0x20 && code < 0x7f) || code >= 0xa0 || code === 0x09;
        if (printable) {
          if (textStart === -1) textStart = i;
          continue;
        }
        flush(i);
        this.control(code);
        continue;
      }
      this.escapeByte(code, chunk[i]!);
    }
    flush(chunk.length);
    this.compact();
  }

  /** The output so far: the kept lines, without the cursor's empty last line, and how many were dropped. */
  snapshot(): AnsiSnapshot {
    if (this.cached) return this.cached;
    for (const index of this.dirty) {
      const line = this.rows[index];
      if (line) this.published[index] = { segments: line.segments.slice(), length: line.length };
    }
    this.dirty.clear();
    let end = this.rows.length;
    // A trailing empty line is the cursor waiting, not output.
    if (end - this.head > 1 && this.rows[end - 1]!.length === 0) end--;
    const start = Math.max(this.head, end - this.maxLines);
    this.cached = {
      lines: this.published.slice(start, end),
      dropped: this.base + start,
    };
    return this.cached;
  }

  /** The kept lines, as {@link snapshot} draws them. */
  get lines(): readonly AnsiLine[] {
    return this.snapshot().lines;
  }

  get dropped(): number {
    return this.snapshot().dropped;
  }

  private control(code: number): void {
    if (code === 0x1b) this.state = State.Escape;
    else if (code === 0x0a) this.newline();
    else if (code === 0x0d) this.col = 0;
    else if (code === 0x08) this.backspace();
    else if (code in C1) this.introduce(C1[code]!);
    // NUL, BEL and the other C0 and C1 controls draw nothing.
  }

  /** Begins what an escape's second byte (or its C1 byte) introduces. */
  private introduce(kind: string): void {
    this.buffer = "";
    this.overflow = false;
    if (kind === "[") this.state = State.Csi;
    else if (kind === "]") {
      this.state = State.Osc;
      this.stringIsOsc = true;
    } else if (kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      this.state = State.Text;
      this.stringIsOsc = false;
    } else this.state = State.Ground;
  }

  private escapeByte(code: number, char: string): void {
    switch (this.state) {
      case State.Escape: {
        if (
          char === "[" ||
          char === "]" ||
          char === "P" ||
          char === "X" ||
          char === "^" ||
          char === "_"
        ) {
          this.introduce(char);
        } else if (char === "(" || char === ")" || char === "*" || char === "+") {
          this.state = State.Charset;
        } else if (code >= 0x20 && code < 0x7f) {
          this.state = State.Ground;
        } else {
          // A control right after ESC: the escape was never one.
          this.state = State.Ground;
          this.control(code);
          if (code >= 0xa0) this.text(char);
        }
        return;
      }
      case State.Charset:
        this.state = State.Ground;
        if (code < 0x20) this.control(code);
        return;
      case State.Csi: {
        if (code >= 0x40 && code <= 0x7e) {
          this.state = State.Ground;
          if (!this.overflow) this.csi(this.buffer, char);
        } else if (code >= 0x20 && code <= 0x3f) {
          if (this.buffer.length < MAX_CSI_CHARS) this.buffer += char;
          else this.overflow = true;
        } else {
          // Malformed: drop what came so far and let the byte that broke it
          // (a newline, a new escape) count as itself.
          this.state = State.Ground;
          this.control(code);
          if (code >= 0xa0) this.text(char);
        }
        return;
      }
      case State.Osc:
      case State.Text: {
        if (code === 0x07 && this.state === State.Osc) this.endString();
        else if (code === 0x9c) this.endString();
        else if (code === 0x1b) this.state = State.StringEscape;
        else if (code === 0x18 || code === 0x1a) this.state = State.Ground;
        else if (code === 0x0a && this.state === State.Osc) {
          // An OSC never spans lines: a stray `\x1b]` must not swallow the rest of the log.
          this.state = State.Ground;
          this.newline();
        } else if (this.stringIsOsc) {
          if (this.buffer.length < MAX_OSC_CHARS) this.buffer += char;
          else this.overflow = true;
        }
        return;
      }
      case State.StringEscape: {
        if (char === "\\") {
          this.endString();
          return;
        }
        // ESC then anything else ends the string unread and starts a new escape.
        this.state = State.Escape;
        this.escapeByte(code, char);
        return;
      }
      default:
    }
  }

  private endString(): void {
    const osc = this.stringIsOsc;
    this.state = State.Ground;
    if (osc && !this.overflow) this.osc(this.buffer);
    this.buffer = "";
  }

  private csi(params: string, final: string): void {
    if (final === "m") {
      // Private markers (`\x1b[>4;2m`) are xterm key modes, not styles.
      if (!/^[\d;:]*$/.test(params)) return;
      this.pen = applySgr(this.pen, params);
      this.restyle();
      return;
    }
    const n = param(params);
    if (n !== null && Number.isNaN(n)) return;
    const count = Math.min(Math.max(1, n ?? 1), MAX_LINE_CHARS);
    switch (final) {
      case "K":
        this.eraseLine(n ?? 0);
        return;
      case "A":
        this.row = Math.max(0, this.row - count);
        return;
      case "B":
        this.row = Math.min(this.base + this.rows.length - 1, this.row + count);
        return;
      case "C":
        this.col = Math.min(MAX_LINE_CHARS, this.col + count);
        return;
      case "D":
        this.col = Math.max(0, this.col - count);
        return;
      case "G":
        this.col = count - 1;
        return;
      default:
    }
  }

  private osc(body: string): void {
    if (!body.startsWith("8;")) return;
    const split = body.indexOf(";", 2);
    const uri = split === -1 ? "" : body.slice(split + 1);
    this.link = uri === "" || uri.length > MAX_LINK_CHARS ? null : uri;
    this.restyle();
  }

  private restyle(): void {
    const next = styleOf(this.pen, this.link);
    if (!sameStyle(next, this.style)) this.style = next;
  }

  /** The cursor's line, or null when the cursor is up among dropped lines. */
  private current(): { index: number; line: WorkLine } | null {
    const index = this.row - this.base;
    if (index < this.head) return null;
    const line = this.rows[index];
    return line ? { index, line } : null;
  }

  private eraseLine(mode: number): void {
    const at = this.current();
    if (!at) return;
    const { line } = at;
    if (mode === 0) {
      if (this.col >= line.length) return;
      line.segments = sliceSegments(line.segments, 0, this.col);
      line.length = this.col;
    } else if (mode === 1) {
      writeAt(line, 0, " ".repeat(Math.min(this.col + 1, line.length)), PLAIN_STYLE);
    } else if (mode === 2) {
      line.segments = [];
      line.length = 0;
    } else return;
    this.dirty.add(at.index);
  }

  private text(text: string): void {
    const room = MAX_LINE_CHARS - this.col;
    const kept = room <= 0 ? "" : text.length > room ? text.slice(0, room) : text;
    const at = this.current();
    if (at && kept !== "") {
      writeAt(at.line, this.col, kept, this.style);
      this.dirty.add(at.index);
    }
    this.col = Math.min(MAX_LINE_CHARS, this.col + text.length);
  }

  private backspace(): void {
    // A wide character is two cells, so backing up lands on its second half;
    // writing there blanks the first, as a terminal does.
    if (this.col > 0) this.col--;
  }

  private newline(): void {
    this.row++;
    this.col = 0;
    const index = this.row - this.base;
    if (index === this.rows.length) {
      this.rows.push({ segments: [], length: 0 });
      this.published.push(EMPTY_LINE);
    }
    // One line past the cap is kept: the cursor's, until it is written.
    const excess = this.rows.length - this.head - (this.maxLines + 1);
    if (excess > 0) this.head += excess;
  }

  /** Lets go of dropped lines in batches, so trimming a long log costs nothing per line. */
  private compact(): void {
    if (this.head < 1024 || this.head * 2 < this.rows.length) return;
    const gone = this.head;
    this.rows.splice(0, gone);
    this.published.splice(0, gone);
    this.base += gone;
    this.head = 0;
    const dirty = new Set<number>();
    for (const index of this.dirty) if (index >= gone) dirty.add(index - gone);
    this.dirty = dirty;
  }
}

/** The whole of `text`, parsed. */
export function parseAnsi(text: string, maxLines = Infinity): AnsiParser {
  const parser = new AnsiParser(maxLines);
  parser.write(text);
  return parser;
}

/** `text` with every escape removed and every rewrite applied: what a terminal would show. */
export function ansiToPlainText(text: string): string {
  return parseAnsi(text).lines.map(lineText).join("\n");
}

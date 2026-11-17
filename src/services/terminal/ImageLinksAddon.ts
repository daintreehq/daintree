import type {
  IBuffer,
  IBufferCell,
  IBufferLine,
  ILink,
  ILinkProvider,
  IBufferRange,
} from "@xterm/xterm";

/**
 * Called when the user clicks an `[image #N]` reference. `openLightbox` is true
 * for a modified click (meta/ctrl), matching `FileLinksAddon`'s convention —
 * #9829 wires it to the lightbox; the highlight is the interim affordance.
 */
export type OnActivateFigure = (figureNumber: number, openLightbox: boolean) => void;

/** The slice of a terminal the provider reads. */
export interface ImageLinkTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: IBuffer };
}

// Bracketed `[image #3]` or bare `image #3`. The bare branch is guarded by
// boundaries so `reimage #3` (leading word char) and `image #3a` (trailing
// word char) don't match, and so the bracketed form's inner text is never
// double-matched. Case-insensitive — assistant output capitalization varies.
const IMAGE_REF_REGEX = /\[image #(\d+)\]|(?<![[\w])image #(\d+)(?![\w])/gi;

// Cells of a soft-wrapped line read either side of the hovered row: far more
// than any reference needs, and a bound on what a hover over a long wrapped
// run costs.
const CONTEXT_CELLS = 256;

/** Text of a run of soft-wrapped rows, and the cell each part of it was drawn in. */
interface WrappedText {
  text: string;
  /** Per cell read: where its text starts in `text`, ascending. */
  offsets: number[];
  /** Per cell read: its 0-based buffer row, and its first and last column. */
  rows: number[];
  startColumns: number[];
  endColumns: number[];
  /** The window starts mid-line: what came before `text` is unknown. */
  clippedStart: boolean;
  /** The window ends mid-line: what comes after `text` is unknown. */
  clippedEnd: boolean;
}

function lineAt(buffer: IBuffer, y: number): IBufferLine | undefined {
  // A full scrollback's ring buffer answers past either end with a live row.
  return y >= 0 && y < buffer.length ? buffer.getLine(y) : undefined;
}

/**
 * Whether a row holds text past the pane's edge, as an alternate-buffer row
 * kept through a narrowing can. Cells never written are spare capacity.
 */
function hidesText(line: IBufferLine, cols: number): boolean {
  let scratch: IBufferCell | undefined;
  for (let x = cols; x < line.length; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell) break;
    scratch = cell;
    if (cell.getChars() !== "" || cell.getWidth() !== 1) return true;
  }
  return false;
}

/**
 * The soft-wrapped line around buffer row `row`, read cell by cell so a match
 * maps back to the columns it was drawn in past wide characters and combining
 * marks. Only xterm's own wraps (`isWrapped`) join rows: a hard line break
 * always ends the line. The blank cell xterm leaves at the edge when a wide
 * character moves down reads as a space; only that wide character follows it,
 * and it can't be part of a reference or a word boundary.
 *
 * Wraps join rows only in the normal buffer, which reflows on every resize so
 * its wraps sit at the pane's width. The alternate buffer keeps rows as drawn:
 * a wrap there may date from an earlier width, its cells since hidden by a
 * narrowing or cut by a widening, so it is an edge the line is clipped at.
 */
function readWrappedText(terminal: ImageLinkTerminal, row: number): WrappedText | null {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const joinsWraps = buffer.type === "normal";
  const hovered = lineAt(buffer, row);
  if (!hovered) return null;

  let top = row;
  let topLine = hovered;
  let clippedStart = false;
  for (let reach = 0; topLine.isWrapped; reach += cols) {
    // No row above means scrollback dropped the start of the line.
    const above = joinsWraps ? lineAt(buffer, top - 1) : undefined;
    if (!above || reach >= CONTEXT_CELLS) {
      clippedStart = true;
      break;
    }
    top--;
    topLine = above;
  }

  let bottom = row;
  let bottomLine = hovered;
  let clippedEnd = false;
  for (let reach = 0; ; reach += cols) {
    if (hidesText(bottomLine, cols)) {
      clippedEnd = true;
      break;
    }
    if (!lineAt(buffer, bottom + 1)?.isWrapped) break;
    if (!joinsWraps || reach >= CONTEXT_CELLS) {
      clippedEnd = true;
      break;
    }
    bottom++;
    bottomLine = buffer.getLine(bottom)!;
  }

  let text = "";
  const offsets: number[] = [];
  const rows: number[] = [];
  const startColumns: number[] = [];
  const endColumns: number[] = [];
  let scratch: IBufferCell | undefined;
  for (let y = top; y <= bottom; y++) {
    const line = buffer.getLine(y)!;
    const cells = Math.min(line.length, cols);
    // Stepping by width, as xterm's own text translation does, passes over a
    // wide character's right half and keeps any other zero-width cell's text.
    for (let x = 0; x < cells;) {
      const cell = line.getCell(x, scratch);
      if (!cell) break;
      scratch = cell;
      const step = cell.getWidth() || 1;
      offsets.push(text.length);
      rows.push(y);
      startColumns.push(x);
      endColumns.push(x + step - 1);
      text += cell.getChars() || " ";
      x += step;
    }
  }
  return { text, offsets, rows, startColumns, endColumns, clippedStart, clippedEnd };
}

/** The cell that drew `text[index]`. */
function cellAt(wrapped: WrappedText, index: number): number {
  let low = 0;
  let high = wrapped.offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (wrapped.offsets[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low;
}

function sameRange(a: IBufferRange, b: IBufferRange): boolean {
  return (
    a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y
  );
}

export class ImageLinksAddon implements ILinkProvider {
  private _terminal: ImageLinkTerminal;
  private _getFigureNumbers: () => readonly number[];
  private _onActivate: OnActivateFigure;

  constructor(
    terminal: ImageLinkTerminal,
    getFigureNumbers: () => readonly number[],
    onActivate: OnActivateFigure
  ) {
    this._terminal = terminal;
    this._getFigureNumbers = getFigureNumbers;
    this._onActivate = onActivate;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const links = this._linksOnRow(bufferLineNumber - 1);
    callback(links.length > 0 ? links : undefined);
  }

  private _linksOnRow(row: number): ImageLink[] {
    // Read figure state live on every hover so links activate the moment a
    // figure arrives and go inert when the session resets — no re-registration.
    const available = new Set(this._getFigureNumbers());
    if (available.size === 0) return [];
    const wrapped = readWrappedText(this._terminal, row);
    if (!wrapped) return [];

    const links: ImageLink[] = [];
    for (const match of wrapped.text.matchAll(IMAGE_REF_REGEX)) {
      const startIndex = match.index;
      const lastIndex = startIndex + match[0].length - 1;
      // The bracketed form carries its own delimiters; the bare form's
      // boundaries and digits can't be judged against text the window cut.
      if (
        match[1] === undefined &&
        ((wrapped.clippedStart && startIndex === 0) ||
          (wrapped.clippedEnd && lastIndex === wrapped.text.length - 1))
      ) {
        continue;
      }
      const figureNumber = Number(match[1] ?? match[2]);
      // Unknown figure numbers stay inert — no link, no hover affordance.
      if (!available.has(figureNumber)) continue;

      const first = cellAt(wrapped, startIndex);
      const last = cellAt(wrapped, lastIndex);
      // xterm evicts lower-priority links that overlap a returned range, so a
      // reference on a sibling row would blank links the user can see here.
      if (wrapped.rows[first]! > row || wrapped.rows[last]! < row) continue;

      const range: IBufferRange = {
        start: { x: wrapped.startColumns[first]! + 1, y: wrapped.rows[first]! + 1 },
        end: { x: wrapped.endColumns[last]! + 1, y: wrapped.rows[last]! + 1 },
      };
      links.push(
        new ImageLink(range, match[0], figureNumber, this._onActivate, () =>
          this._stillLinks(range, match[0])
        )
      );
    }
    return links;
  }

  /**
   * Whether the buffer still draws this reference. xterm drops a hovered link
   * only when a redraw covers its whole range, so output rewriting just one
   * row of a wrapped reference would otherwise leave it opening the old figure.
   */
  private _stillLinks(range: IBufferRange, text: string): boolean {
    return this._linksOnRow(range.start.y - 1).some(
      (link) => link.text === text && sameRange(link.range, range)
    );
  }

  dispose(): void {}
}

// No hover/leave callbacks on purpose: those feed `ManagedTerminal.hoveredLink`,
// which drives the right-click "Open link" / "Copy link address" menu and the
// open-hovered-link shortcut. An `[image #N]` reference is not a URL or path, so
// surfacing it there would be misleading — the pointer/underline decorations are
// the affordance, and click activation routes through the provider directly.
class ImageLink implements ILink {
  decorations = { pointerCursor: true, underline: true };

  constructor(
    public range: IBufferRange,
    public text: string,
    private _figureNumber: number,
    private _onActivate: OnActivateFigure,
    private _isCurrent: () => boolean
  ) {}

  activate(event: MouseEvent, _text: string): void {
    if (!this._isCurrent()) return;
    this._onActivate(this._figureNumber, event.metaKey || event.ctrlKey);
  }

  dispose?(): void {}
}

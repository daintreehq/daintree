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

/** Text of a run of soft-wrapped rows, with the cell each UTF-16 unit was drawn in. */
interface WrappedText {
  text: string;
  /** 0-based buffer row of each code unit. */
  rows: number[];
  /** First and last buffer column of the cell each code unit was drawn in. */
  startColumns: number[];
  endColumns: number[];
  /** The window starts mid-line: what came before `text` is unknown. */
  clippedStart: boolean;
  /** The window ends mid-line: what comes after `text` is unknown. */
  clippedEnd: boolean;
}

function lineAt(buffer: IBuffer, y: number): IBufferLine | undefined {
  // A full scrollback's ring buffer answers past its end with its first row.
  return y >= 0 && y < buffer.length ? buffer.getLine(y) : undefined;
}

/**
 * The soft-wrapped line around buffer row `row`, read cell by cell so a match
 * maps back to the columns it was drawn in past wide characters and combining
 * marks. Only xterm's own wraps (`isWrapped`) join rows: a hard line break
 * always ends the line. The blank cell xterm leaves at the edge when a wide
 * character moves down reads as a space; only that wide character follows it,
 * and it can't be part of a reference or a word boundary.
 *
 * A row longer than the pane (an alternate buffer narrowed without reflow)
 * keeps text past the edge, so the row below it doesn't continue what's on
 * screen: the line ends there as a clipped edge.
 */
function readWrappedText(terminal: ImageLinkTerminal, row: number): WrappedText | null {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const hovered = lineAt(buffer, row);
  if (!hovered) return null;

  let top = row;
  let topLine = hovered;
  let clippedStart = false;
  for (let reach = 0; topLine.isWrapped; reach += cols) {
    const above = lineAt(buffer, top - 1);
    // No row above means scrollback dropped the start of the line.
    if (!above || above.length > cols || reach >= CONTEXT_CELLS) {
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
    if (bottomLine.length > cols) {
      clippedEnd = true;
      break;
    }
    const below = lineAt(buffer, bottom + 1);
    if (!below?.isWrapped) break;
    if (reach >= CONTEXT_CELLS) {
      clippedEnd = true;
      break;
    }
    bottom++;
    bottomLine = below;
  }

  let text = "";
  const rows: number[] = [];
  const startColumns: number[] = [];
  const endColumns: number[] = [];
  let scratch: IBufferCell | undefined;
  for (let y = top; y <= bottom; y++) {
    const line = buffer.getLine(y)!;
    const cells = Math.min(line.length, cols);
    for (let x = 0; x < cells; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) break;
      scratch = cell;
      const width = cell.getWidth();
      // The right half of a wide character: its left half carried the text.
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) {
        rows.push(y);
        startColumns.push(x);
        endColumns.push(x + width - 1);
      }
      text += chars;
    }
  }
  return { text, rows, startColumns, endColumns, clippedStart, clippedEnd };
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
    // Read figure state live on every hover so links activate the moment a
    // figure arrives and go inert when the session resets — no re-registration.
    const available = new Set(this._getFigureNumbers());
    const row = bufferLineNumber - 1;
    const wrapped = row < 0 || available.size === 0 ? null : readWrappedText(this._terminal, row);
    if (!wrapped) {
      callback(undefined);
      return;
    }

    const links: ILink[] = [];
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

      const startRow = wrapped.rows[startIndex]!;
      const endRow = wrapped.rows[lastIndex]!;
      // xterm evicts lower-priority links that overlap a returned range, so a
      // reference on a sibling row would blank links the user can see here.
      if (startRow > row || endRow < row) continue;

      const range: IBufferRange = {
        start: { x: wrapped.startColumns[startIndex]! + 1, y: startRow + 1 },
        end: { x: wrapped.endColumns[lastIndex]! + 1, y: endRow + 1 },
      };
      links.push(new ImageLink(range, match[0], figureNumber, this._onActivate));
    }

    callback(links.length > 0 ? links : undefined);
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
    private _onActivate: OnActivateFigure
  ) {}

  activate(event: MouseEvent, _text: string): void {
    this._onActivate(this._figureNumber, event.metaKey || event.ctrlKey);
  }

  dispose?(): void {}
}

import type { Terminal, ILinkProvider, ILink, IBufferRange } from "@xterm/xterm";

/**
 * Called when the user clicks an `[image #N]` reference. `openLightbox` is true
 * for a modified click (meta/ctrl), matching `FileLinksAddon`'s convention —
 * #9829 wires it to the lightbox; the highlight is the interim affordance.
 */
export type OnActivateFigure = (figureNumber: number, openLightbox: boolean) => void;

// Bracketed `[image #3]` or bare `image #3`. The bare branch is guarded by
// boundaries so `reimage #3` (leading word char) and `image #3a` (trailing
// word char) don't match, and so the bracketed form's inner text is never
// double-matched. Case-insensitive — assistant output capitalization varies.
const IMAGE_REF_REGEX = /\[image #(\d+)\]|(?<![[\w])image #(\d+)(?![\w])/gi;

export class ImageLinksAddon implements ILinkProvider {
  private _terminal: Terminal;
  private _getFigureNumbers: () => readonly number[];
  private _onActivate: OnActivateFigure;

  constructor(
    terminal: Terminal,
    getFigureNumbers: () => readonly number[],
    onActivate: OnActivateFigure
  ) {
    this._terminal = terminal;
    this._getFigureNumbers = getFigureNumbers;
    this._onActivate = onActivate;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    if (bufferLineNumber < 1) {
      callback(undefined);
      return;
    }
    const line = this._terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    // Read figure state live on every hover so links activate the moment a
    // figure arrives and go inert when the session resets — no re-registration.
    const available = new Set(this._getFigureNumbers());
    if (available.size === 0) {
      callback(undefined);
      return;
    }

    const lineText = line.translateToString(true);
    const regex = new RegExp(IMAGE_REF_REGEX);
    const links: ILink[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(lineText)) !== null) {
      const digits = match[1] ?? match[2];
      if (digits === undefined) continue;
      const figureNumber = Number(digits);
      // Unknown figure numbers stay inert — no link, no hover affordance.
      if (!available.has(figureNumber)) continue;

      const startIndex = match.index;
      const range: IBufferRange = {
        start: { x: startIndex + 1, y: bufferLineNumber },
        end: { x: startIndex + match[0].length, y: bufferLineNumber },
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

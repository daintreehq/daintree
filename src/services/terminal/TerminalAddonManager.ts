import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinksAddon, HoverCallback } from "./FileLinksAddon";
import { ImageLinksAddon, OnActivateFigure } from "./ImageLinksAddon";

const IMAGE_ADDON_OPTIONS = { pixelLimit: 2_000_000, storageLimit: 8 };

export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  imageAddon: ImageAddon | null;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable | null;
  imageLinksDisposable: IDisposable | null;
  webLinksAddon: WebLinksAddon | null;
}

export interface WebLinksHoverHandlers {
  hover: (event: MouseEvent, text: string) => void;
  leave: () => void;
}

export function setupTerminalAddons(terminal: Terminal): TerminalAddons {
  // Eager core set — only the addons whose absence would corrupt the very first
  // frame or break restore. FitAddon (sizing) and SerializeAddon (snapshot
  // save/restore) are always needed; Unicode11 must be active before any data
  // is written so cell widths are recorded correctly. The heavier, tier-managed
  // addons (Image DCS handlers, file/web link providers) are deferred to
  // `ensureDeferredAddons()` once a terminal is actually opened, so bulk session
  // restore doesn't build them for terminals that may never be shown (#9809).
  // WebGL is managed separately by TerminalWebGLManager (focused terminal only).

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  // xterm 6.0 ships with Unicode 6 width tables, so modern emoji and many CJK
  // glyphs render at 1 cell instead of 2. Activate Unicode 11 widths before any
  // data is written so the buffer records correct cell widths from the start.
  const unicode11Addon = new Unicode11Addon();
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = "11";

  // SearchAddon registers no parser hooks and does nothing until a search is
  // invoked, so it stays in the eager set — keeping it non-null avoids a
  // nullable-search blast radius across TerminalSearchBar and the wake path.
  const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
  terminal.loadAddon(searchAddon);

  return {
    fitAddon,
    serializeAddon,
    imageAddon: null,
    searchAddon,
    fileLinksDisposable: null,
    imageLinksDisposable: null,
    webLinksAddon: null,
  };
}

export function createImageAddon(terminal: Terminal): ImageAddon {
  const addon = new ImageAddon(IMAGE_ADDON_OPTIONS);
  terminal.loadAddon(addon);
  return addon;
}

export function createFileLinksAddon(
  terminal: Terminal,
  getCwd: () => string,
  onHover?: HoverCallback
): IDisposable {
  const addon = new FileLinksAddon(terminal, getCwd, onHover);
  return terminal.registerLinkProvider(addon);
}

export function createImageLinksAddon(
  terminal: Terminal,
  getFigureNumbers: () => readonly number[],
  onActivate: OnActivateFigure
): IDisposable {
  const addon = new ImageLinksAddon(terminal, getFigureNumbers, onActivate);
  return terminal.registerLinkProvider(addon);
}

export function createWebLinksAddon(
  terminal: Terminal,
  onActivate: (event: MouseEvent, uri: string) => void,
  hoverHandlers?: WebLinksHoverHandlers
): WebLinksAddon {
  const addon = new WebLinksAddon(onActivate, {
    hover: hoverHandlers ? (event, text) => hoverHandlers.hover(event, text) : undefined,
    leave: hoverHandlers ? () => hoverHandlers.leave() : undefined,
  });
  terminal.loadAddon(addon);
  return addon;
}

import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinksAddon, HoverCallback } from "./FileLinksAddon";

const IMAGE_ADDON_OPTIONS = { pixelLimit: 2_000_000, storageLimit: 8 };

export const SEARCH_HIGHLIGHT_LIMIT = 1000;

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  imageAddon: ImageAddon | null;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable | null;
  webLinksAddon: WebLinksAddon | null;
}

export interface WebLinksHoverHandlers {
  hover: (event: MouseEvent, text: string) => void;
  leave: () => void;
}

export function setupTerminalAddons(
  terminal: Terminal,
  getCwd: () => string,
  onLinkActivate?: (event: MouseEvent, uri: string) => void,
  onFileLinkHover?: HoverCallback,
  webLinksHover?: WebLinksHoverHandlers
): TerminalAddons {
  // Base addons loaded for all terminals. WebGL is managed separately
  // by TerminalWebGLManager (attached only to the focused terminal).

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  const imageAddon = new ImageAddon(IMAGE_ADDON_OPTIONS);
  terminal.loadAddon(imageAddon);

  const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
  terminal.loadAddon(searchAddon);

  const fileLinksAddon = new FileLinksAddon(terminal, getCwd, onFileLinkHover);
  const fileLinksDisposable = terminal.registerLinkProvider(fileLinksAddon);

  let webLinksAddon: WebLinksAddon | null = null;
  if (onLinkActivate) {
    webLinksAddon = new WebLinksAddon(onLinkActivate, {
      hover: webLinksHover ? (event, text) => webLinksHover.hover(event, text) : undefined,
      leave: webLinksHover ? () => webLinksHover.leave() : undefined,
    });
    terminal.loadAddon(webLinksAddon);
  }

  return {
    fitAddon,
    serializeAddon,
    imageAddon,
    searchAddon,
    fileLinksDisposable,
    webLinksAddon,
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

import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinksAddon } from "./FileLinksAddon";

const IMAGE_ADDON_OPTIONS = { pixelLimit: 2_000_000, storageLimit: 8 };

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  imageAddon: ImageAddon | null;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable | null;
  webLinksAddon: WebLinksAddon | null;
}

export function setupTerminalAddons(
  terminal: Terminal,
  getCwd: () => string,
  onLinkActivate?: (event: MouseEvent, uri: string) => void
): TerminalAddons {
  // Base addons loaded for all terminals. WebGL is managed separately
  // by TerminalWebGLManager (attached only to the focused terminal).

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  const imageAddon = new ImageAddon(IMAGE_ADDON_OPTIONS);
  terminal.loadAddon(imageAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  const fileLinksAddon = new FileLinksAddon(terminal, getCwd);
  const fileLinksDisposable = terminal.registerLinkProvider(fileLinksAddon);

  let webLinksAddon: WebLinksAddon | null = null;
  if (onLinkActivate) {
    webLinksAddon = new WebLinksAddon(onLinkActivate);
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

export function createFileLinksAddon(terminal: Terminal, getCwd: () => string): IDisposable {
  const addon = new FileLinksAddon(terminal, getCwd);
  return terminal.registerLinkProvider(addon);
}

export function createWebLinksAddon(
  terminal: Terminal,
  onActivate: (event: MouseEvent, uri: string) => void
): WebLinksAddon {
  const addon = new WebLinksAddon(onActivate);
  terminal.loadAddon(addon);
  return addon;
}

import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { FileLinksAddon } from "./FileLinksAddon";

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
  imageAddon: ImageAddon;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable;
}

export function setupTerminalAddons(
  terminal: Terminal,
  openLink: (url: string, event?: MouseEvent) => void,
  getCwd: () => string
): TerminalAddons {
  // Base addons loaded for all terminals. WebGL is managed separately
  // by TerminalWebGLManager (attached only to the focused terminal).

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  const webLinksAddon = new WebLinksAddon((event, uri) => openLink(uri, event));
  terminal.loadAddon(webLinksAddon);

  const imageAddon = new ImageAddon();
  terminal.loadAddon(imageAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  const fileLinksAddon = new FileLinksAddon(terminal, getCwd);
  const fileLinksDisposable = terminal.registerLinkProvider(fileLinksAddon);

  return {
    fitAddon,
    serializeAddon,
    webLinksAddon,
    imageAddon,
    searchAddon,
    fileLinksDisposable,
  };
}

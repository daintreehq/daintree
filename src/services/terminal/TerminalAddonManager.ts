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
  openLink: (url: string) => void,
  getCwd: () => string
): TerminalAddons {
  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  const webLinksAddon = new WebLinksAddon((_event, uri) => openLink(uri));
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

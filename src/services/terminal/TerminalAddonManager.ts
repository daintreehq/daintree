import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
  imageAddon: ImageAddon;
  searchAddon: SearchAddon;
}

export function setupTerminalAddons(
  terminal: Terminal,
  openLink: (url: string) => void
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

  return {
    fitAddon,
    serializeAddon,
    webLinksAddon,
    imageAddon,
    searchAddon,
  };
}

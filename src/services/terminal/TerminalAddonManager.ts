import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { FileLinksAddon } from "./FileLinksAddon";

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  imageAddon: ImageAddon | null;
  searchAddon: SearchAddon;
  fileLinksDisposable: IDisposable | null;
}

export function setupTerminalAddons(terminal: Terminal, getCwd: () => string): TerminalAddons {
  // Base addons loaded for all terminals. WebGL is managed separately
  // by TerminalWebGLManager (attached only to the focused terminal).

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);

  const imageAddon = new ImageAddon();
  terminal.loadAddon(imageAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  const fileLinksAddon = new FileLinksAddon(terminal, getCwd);
  const fileLinksDisposable = terminal.registerLinkProvider(fileLinksAddon);

  return {
    fitAddon,
    serializeAddon,
    imageAddon,
    searchAddon,
    fileLinksDisposable,
  };
}

export function createImageAddon(terminal: Terminal): ImageAddon {
  const addon = new ImageAddon();
  terminal.loadAddon(addon);
  return addon;
}

export function createFileLinksAddon(terminal: Terminal, getCwd: () => string): IDisposable {
  const addon = new FileLinksAddon(terminal, getCwd);
  return terminal.registerLinkProvider(addon);
}

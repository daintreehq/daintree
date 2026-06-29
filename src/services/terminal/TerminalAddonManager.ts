import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinksAddon, HoverCallback } from "./FileLinksAddon";
import { ImageLinksAddon, OnActivateFigure } from "./ImageLinksAddon";

const IMAGE_ADDON_OPTIONS = { pixelLimit: 2_000_000, storageLimit: 8 };

// @xterm/addon-image (~79KB) and @xterm/addon-unicode11 (~14KB) load via dynamic
// import so their module code stays out of the renderer's eager critical path —
// they are parsed/compiled only when a terminal actually needs them, not on every
// project-view load (#10840). This mirrors the lazy WebGL loader in
// TerminalWebGLManager.ts: a module-level class cache plus a single in-flight
// promise guard so concurrent callers share one import, and the promise is nulled
// on failure so a later call can retry.
type ImageAddonConstructor = new (options?: typeof IMAGE_ADDON_OPTIONS) => ImageAddon;
type Unicode11AddonConstructor = new () => Unicode11Addon;

let ImageAddonClass: ImageAddonConstructor | null = null;
let imageAddonLoadPromise: Promise<ImageAddonConstructor> | null = null;

function loadImageAddon(): Promise<ImageAddonConstructor> {
  if (ImageAddonClass) return Promise.resolve(ImageAddonClass);
  if (imageAddonLoadPromise) return imageAddonLoadPromise;
  imageAddonLoadPromise = import("@xterm/addon-image").then(
    (mod) => {
      ImageAddonClass = mod.ImageAddon as unknown as ImageAddonConstructor;
      return ImageAddonClass;
    },
    (err) => {
      imageAddonLoadPromise = null;
      throw err;
    }
  );
  return imageAddonLoadPromise;
}

let Unicode11AddonClass: Unicode11AddonConstructor | null = null;
let unicode11AddonLoadPromise: Promise<Unicode11AddonConstructor> | null = null;

function loadUnicode11Addon(): Promise<Unicode11AddonConstructor> {
  if (Unicode11AddonClass) return Promise.resolve(Unicode11AddonClass);
  if (unicode11AddonLoadPromise) return unicode11AddonLoadPromise;
  unicode11AddonLoadPromise = import("@xterm/addon-unicode11").then(
    (mod) => {
      Unicode11AddonClass = mod.Unicode11Addon as unknown as Unicode11AddonConstructor;
      return Unicode11AddonClass;
    },
    (err) => {
      unicode11AddonLoadPromise = null;
      throw err;
    }
  );
  return unicode11AddonLoadPromise;
}

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

export async function setupTerminalAddons(terminal: Terminal): Promise<TerminalAddons> {
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
  // The addon module is lazy-loaded (#10840), so this is awaited here — and the
  // single caller, getOrCreate(), awaits setupTerminalAddons before wiring the
  // PTY data listener, keeping the activation strictly before any write. A load
  // failure degrades gracefully to Unicode 6 widths rather than failing terminal
  // creation: a terminal with mis-measured emoji is far better than no terminal.
  try {
    const Unicode11AddonCtor = await loadUnicode11Addon();
    const unicode11Addon = new Unicode11AddonCtor();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";
  } catch (err) {
    console.warn(
      "[TerminalAddonManager] Failed to load Unicode11 addon — falling back to Unicode 6 widths",
      err
    );
  }

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

export async function createImageAddon(terminal: Terminal): Promise<ImageAddon> {
  const ImageAddonCtor = await loadImageAddon();
  const addon = new ImageAddonCtor(IMAGE_ADDON_OPTIONS);
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

// Internal hooks — exposed only for tests in this repo. The lazy loaders cache
// the resolved class at module scope, so a test that exercises a load failure
// must reset that cache to avoid leaking state into the next test. Mirrors the
// `__testing` surface on TerminalWebGLManager.
export const __testing = {
  resetLoaderState(): void {
    ImageAddonClass = null;
    imageAddonLoadPromise = null;
    Unicode11AddonClass = null;
    unicode11AddonLoadPromise = null;
  },
};

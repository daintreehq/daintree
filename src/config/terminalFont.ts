// Default terminal font configuration.
// JetBrains Mono is bundled with the application via @fontsource/jetbrains-mono.
// These values are used both for initial xterm creation and for the global
// terminal config hook, so changing them updates the look consistently.

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

// Slightly smaller than our previous 13px to reduce the number of cells
// on screen and better match VS Code's perceived density/performance.
export const DEFAULT_TERMINAL_FONT_SIZE = 12;

const FONT_LOAD_TIMEOUT_MS = 3_000;

let fontLoadPromise: Promise<void> | null = null;

export function ensureTerminalFontLoaded(): Promise<void> {
  if (fontLoadPromise) return fontLoadPromise;

  if (typeof document === "undefined" || !document.fonts) {
    fontLoadPromise = Promise.resolve();
    return fontLoadPromise;
  }

  const size = `${DEFAULT_TERMINAL_FONT_SIZE}px 'JetBrains Mono'`;
  fontLoadPromise = Promise.race([
    Promise.all([document.fonts.load(size), document.fonts.load(`bold ${size}`)]),
    new Promise<FontFace[]>((resolve) => setTimeout(() => resolve([]), FONT_LOAD_TIMEOUT_MS)),
  ]).then(
    () => undefined,
    () => undefined
  );

  return fontLoadPromise;
}

// Eagerly kick off the font load at module import so components can `use()`
// the same promise reference without having to call `ensureTerminalFontLoaded()`
// in render. Holding a stable module-level reference is required to prevent
// `use()` from throwing a new promise on every render (infinite suspense).
export const terminalFontReady: Promise<void> = ensureTerminalFontLoaded();

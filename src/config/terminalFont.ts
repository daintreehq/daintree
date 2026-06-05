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

// Set once JetBrains Mono finishes loading *after* the startup timeout already
// unblocked terminal creation. In that window terminals open and measure their
// cell metrics against the fallback monospace stack, so the grid is sized wrong
// for the rest of the session (#9776) until something forces a re-measure.
let fontArrivedLate = false;
const lateArrivalCallbacks = new Set<() => void>();

function notifyTerminalFontArrivedLate(): void {
  if (fontArrivedLate) return;
  fontArrivedLate = true;
  // Snapshot then clear: this is a one-shot signal, and a callback must not be
  // able to re-register itself into the set we're iterating.
  const callbacks = [...lateArrivalCallbacks];
  lateArrivalCallbacks.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // A misbehaving subscriber must not prevent the others from repairing.
    }
  }
}

export function ensureTerminalFontLoaded(): Promise<void> {
  if (fontLoadPromise) return fontLoadPromise;

  if (typeof document === "undefined" || !document.fonts) {
    fontLoadPromise = Promise.resolve();
    return fontLoadPromise;
  }

  const size = `${DEFAULT_TERMINAL_FONT_SIZE}px 'JetBrains Mono'`;
  // The race times out terminal creation, but the underlying font fetch keeps
  // running — `document.fonts.load` is not cancelled. Hold a reference to the
  // real load so we can tell when JetBrains Mono actually arrived.
  const realLoad = Promise.all([document.fonts.load(size), document.fonts.load(`bold ${size}`)]);

  let timedOut = false;
  fontLoadPromise = Promise.race([
    realLoad,
    new Promise<FontFace[]>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve([]);
      }, FONT_LOAD_TIMEOUT_MS)
    ),
  ]).then(
    () => undefined,
    () => undefined
  );

  // If the real load only settles after the timeout already unblocked the gate,
  // the font arrived late and any terminal opened in the meantime is mis-sized.
  // Chaining off `realLoad` (rather than a `document.fonts` `loadingdone`
  // listener) keys the signal to JetBrains Mono specifically, so an unrelated
  // late font load can't trigger a spurious repair.
  void realLoad.then(
    () => {
      if (timedOut) notifyTerminalFontArrivedLate();
    },
    () => {
      // Genuine load failure: nothing arrived, so there is nothing to repair.
    }
  );

  return fontLoadPromise;
}

/**
 * Subscribe to the rare case where JetBrains Mono finishes loading *after* the
 * startup timeout already unblocked terminal creation (#9776). Fires at most
 * once. If the font already arrived late by the time you subscribe, the callback
 * runs synchronously. No-op if the font loads on time or fails to load.
 *
 * @returns an unsubscribe function.
 */
export function onTerminalFontArrivedLate(callback: () => void): () => void {
  if (fontArrivedLate) {
    callback();
    return () => {};
  }
  lateArrivalCallbacks.add(callback);
  return () => {
    lateArrivalCallbacks.delete(callback);
  };
}

// Eagerly kick off the font load at module import so components can `use()`
// the same promise reference without having to call `ensureTerminalFontLoaded()`
// in render. Holding a stable module-level reference is required to prevent
// `use()` from throwing a new promise on every render (infinite suspense).
export const terminalFontReady: Promise<void> = ensureTerminalFontLoaded();

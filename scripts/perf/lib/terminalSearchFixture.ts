import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/headless";
import { createHeadlessTerminal, createRng } from "./workloads";

/**
 * Fixture for the terminal find-in-scrollback scenarios (PERF-193/194).
 *
 * Loads the real `@xterm/addon-search` onto a real `@xterm/headless` terminal
 * and drives it through the app's own `buildSearchOptions`, so the measured
 * work is production's: the buffer walk, the regex/whole-word matching, and
 * `_highlightAllMatches`, which walks the buffer on every search to collect
 * matches up to the addon's 1,000-match highlight limit — not just the one
 * being jumped to. That collection pass is what makes search cost scale with
 * scrollback rather than with distance to the next hit.
 *
 * TWO CACHE STATES, MEASURED SEPARATELY. `SearchLineCache` memoizes the
 * buffer-cell-to-string translation for 15s, refreshing that window on every
 * search and dropping it on `onLineFeed` / `onCursorMove` / `onResize`. So a
 * terminal that is still streaming output pays the translation on essentially
 * every search, while a quiet one pays it once. Benchmarking only the quiet
 * case would hide any regression in translation, which is the expensive half.
 * `invalidateLineCache()` writes one line feed — exactly what live output does
 * — to force the cold state deterministically.
 *
 * FIDELITY GAP — read before trusting a delta: headless has no render service,
 * so `registerDecoration` is shimmed. The shim is faithful about LIFECYCLE (it
 * fires `onDispose` listeners exactly once, which is how the addon releases the
 * real markers it registers), but it never paints, and `onRender` listeners
 * therefore never fire. The scan, the match collection, and marker
 * registration/disposal are real; painting the highlight overlays is not. The
 * absolute numbers are a floor, not the whole cost the user sees.
 */

/** Words a developer actually greps for, mixed into the synthetic corpus. */
const CORPUS_TOKENS = [
  "error",
  "warning",
  "info",
  "compiled",
  "module",
  "src/components/Terminal/index.tsx",
  "electron/services/PtyManager.ts",
  "node_modules",
  "passed",
  "failed",
  "TypeError",
  "undefined",
  "await",
  "resolved",
  "chunk",
  "bundle",
  "vite",
  "tsc",
] as const;

/**
 * A deterministic build/agent-output corpus. Shape matters: real matches are
 * scattered across the whole buffer at a realistic density, so the enumeration
 * pass has genuine work rather than one lucky early hit.
 */
export function buildSearchCorpus(lines: number, seed: number): string {
  const rng = createRng(seed);
  const parts: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const token = (): string => CORPUS_TOKENS[Math.floor(rng() * CORPUS_TOKENS.length)]!;
    parts.push(
      `[${i}] ${token()} ${token()} ${token()} ${Math.floor(rng() * 1_000_000)} ${token()}`
    );
  }
  return `${parts.join("\r\n")}\r\n`;
}

export interface SearchableTerminal {
  terminal: Terminal;
  addon: SearchAddon;
  /** Decorations created by the most recent search; reset by resetDecorationCount(). */
  decorationCount: () => number;
  resetDecorationCount: () => void;
  /** Live count of markers registered on the terminal — must stay bounded. */
  markerCount: () => number;
  /**
   * Drop the addon's translated-line cache by feeding one line, the way live
   * terminal output does. Call before a search that should measure the cold
   * path. Resolves once the write has been parsed.
   */
  invalidateLineCache: () => Promise<void>;
  bufferLines: number;
}

/**
 * Minimal shims for the terminal APIs SearchAddon reaches for that headless
 * does not implement. Selection is real state (the addon reads it back to
 * decide where the next match starts from), so a stubbed selection would make
 * `findNext` restart from the top every call and understate stepping cost.
 *
 * The decoration shim MUST honour disposal. The addon registers a real marker
 * per match and releases it from the decoration's `onDispose` callback; a
 * no-op `dispose` leaks every marker onto a terminal this fixture caches for
 * the whole process, which both grows without bound and slows later scrolling
 * work — a benchmark that corrupts its own later samples.
 */
function installSearchShims(terminal: Terminal, onDecoration: () => void): void {
  const host = terminal as unknown as Record<string, unknown>;
  let selection: unknown;

  host.getSelectionPosition = (): unknown => selection;
  host.select = (column: number, row: number, length: number): void => {
    selection = { start: { x: column, y: row }, end: { x: column + length, y: row } };
  };
  host.clearSelection = (): void => {
    selection = undefined;
  };
  host.hasSelection = (): boolean => selection !== undefined;
  host.getSelection = (): string => "";
  host.registerDecoration = (options: { marker?: unknown }): unknown => {
    onDecoration();
    const disposeListeners = new Set<() => void>();
    let disposed = false;
    const listen = (set: Set<() => void>, cb: () => void): { dispose: () => void } => {
      set.add(cb);
      return { dispose: () => set.delete(cb) };
    };
    return {
      marker: options?.marker,
      element: undefined,
      // Never fires: headless does not render. Registering it keeps the addon's
      // disposable bookkeeping identical to production.
      onRender: (cb: () => void) => listen(new Set<() => void>(), cb),
      onDispose: (cb: () => void) => listen(disposeListeners, cb),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const cb of [...disposeListeners]) cb();
      },
    };
  };
}

/**
 * Build a terminal whose scrollback is FULL at `scrollbackLines` — the state a
 * long-running agent terminal is in. Writing more than the scrollback holds is
 * deliberate: it forces the trim path so the buffer is at its steady-state size
 * rather than partially filled.
 */
export async function createSearchableTerminal(
  scrollbackLines: number,
  seed: number
): Promise<SearchableTerminal> {
  const terminal = await createHeadlessTerminal({
    cols: 120,
    rows: 40,
    scrollback: scrollbackLines,
  });

  let decorations = 0;
  installSearchShims(terminal, () => {
    decorations += 1;
  });

  const { SearchAddon: SearchAddonCtor } = await import("@xterm/addon-search");
  const addon = new SearchAddonCtor();
  terminal.loadAddon(addon);

  const corpus = buildSearchCorpus(Math.floor(scrollbackLines * 1.2), seed);
  await new Promise<void>((resolve) => {
    terminal.write(corpus, () => resolve());
  });

  return {
    terminal,
    addon,
    decorationCount: () => decorations,
    resetDecorationCount: () => {
      decorations = 0;
    },
    markerCount: () => terminal.markers.length,
    invalidateLineCache: () =>
      new Promise<void>((resolve) => {
        terminal.write("\r\n", () => resolve());
      }),
    bufferLines: terminal.buffer.active.length,
  };
}

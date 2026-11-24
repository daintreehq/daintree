import { FIND_CURRENT_HIGHLIGHT, FIND_MATCH_HIGHLIGHT } from "../renderedFind";

/** A registry entry that counts its writes; every write restyles the ranges it holds. */
export class CountingHighlight extends Set<Range> {
  priority = 0;
  adds = 0;
  deletes = 0;
  override add(range: Range) {
    this.adds++;
    return super.add(range);
  }
  override delete(range: Range) {
    this.deletes++;
    return super.delete(range);
  }
}

// Scoped stubs: `vi.unstubAllGlobals()` would also undo the setup file's
// ResizeObserver and rAF stubs for the rest of the file.
const restores: Array<() => void> = [];
function stub(target: object, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(target, name, previous);
    else Reflect.deleteProperty(target, name);
  });
}

/** Undoes every stub `stubFindHighlights` installed, newest first. */
export function restoreFindHighlights() {
  while (restores.length > 0) restores.pop()!();
}

/**
 * The CSS Custom Highlight API jsdom lacks, plus a forced-colours media query
 * the test can flip and announce.
 */
export function stubFindHighlights() {
  const registry = new Map<string, CountingHighlight>();
  const media = {
    forced: false,
    listeners: new Set<() => void>(),
    setForced(forced: boolean) {
      media.forced = forced;
      for (const listener of media.listeners) listener();
    },
  };
  stub(CSS, "highlights", registry);
  stub(globalThis, "Highlight", CountingHighlight);
  stub(globalThis, "matchMedia", () => ({
    get matches() {
      return media.forced;
    },
    addEventListener: (_type: string, listener: () => void) => media.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => media.listeners.delete(listener),
  }));
  const entry = (name: string) => registry.get(name)!;
  return {
    media,
    matches: () => entry(FIND_MATCH_HIGHLIGHT),
    current: () => entry(FIND_CURRENT_HIGHLIGHT),
    resetCounts() {
      for (const highlight of registry.values()) highlight.adds = highlight.deletes = 0;
    },
    /** Swaps an entry for an empty one, as another page script could. */
    replace(name: string) {
      registry.set(name, new CountingHighlight());
    },
    /** Withdraws the Highlight constructor, leaving the registry in place. */
    withdrawApi() {
      stub(globalThis, "Highlight", undefined);
    },
  };
}

export type FindHighlights = ReturnType<typeof stubFindHighlights>;

/** The sole range a highlight holds; fails when it holds none or several. */
export function sole(highlight: Set<Range>): Range | undefined {
  if (highlight.size !== 1) throw new Error(`expected 1 range, found ${highlight.size}`);
  return [...highlight][0];
}

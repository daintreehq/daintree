// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  FIND_CURRENT_HIGHLIGHT,
  FIND_MATCH_HIGHLIGHT,
  buildFindPattern,
  createFindPainter,
  findInRenderedText,
  selectionSeed,
} from "../renderedFind";

function documentWith(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function found(root: HTMLElement, query: string, matchCase = false, limit?: number): string[] {
  return findInRenderedText(root, query, matchCase, limit).ranges.map((range) => range.toString());
}

// Scoped stubs: `vi.unstubAllGlobals()` would also undo the setup file's
// ResizeObserver and rAF stubs for the rest of the file.
const restoreGlobals: Array<() => void> = [];
function stubGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restoreGlobals.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  while (restoreGlobals.length > 0) restoreGlobals.pop()!();
});

describe("findInRenderedText", () => {
  it("finds a word split across inline formatting and highlight spans", () => {
    const root = documentWith(
      '<p>A <strong>Zu</strong>stand store.</p><pre><code><span class="k">use</span>PanelStore</code></pre>'
    );
    expect(found(root, "zustand")).toEqual(["Zustand"]);
    expect(found(root, "usePanelStore")).toEqual(["usePanelStore"]);
  });

  it("never joins the end of one block to the start of the next", () => {
    const root = documentWith("<h2>Store</h2><p>families</p><ul><li>one</li><li>two</li></ul>");
    expect(found(root, "store families")).toEqual([]);
    expect(found(root, "storefamilies")).toEqual([]);
    expect(found(root, "onetwo")).toEqual([]);
  });

  it("matches a phrase across a soft line break", () => {
    const root = documentWith("<p>reads the persisted\nsnapshot for that view</p>");
    expect(found(root, "persisted snapshot")).toEqual(["persisted\nsnapshot"]);
  });

  it("skips text the reader cannot see or read as the document", () => {
    const root = documentWith(
      '<p>store<span class="sr-only">store</span><span aria-hidden="true">store</span></p>' +
        "<svg><text>store</text></svg><button>store</button>"
    );
    expect(found(root, "store")).toHaveLength(1);
  });

  it("ignores case unless asked to match it", () => {
    const root = documentWith("<p>Store store STORE</p>");
    expect(found(root, "store")).toHaveLength(3);
    expect(found(root, "Store", true)).toEqual(["Store"]);
  });

  it("treats the query as literal text", () => {
    const root = documentWith("<p>axb a.b (a)</p>");
    expect(found(root, "a.b")).toEqual(["a.b"]);
    expect(found(root, "(a)")).toEqual(["(a)"]);
  });

  it("stops at the limit and says there were more", () => {
    const root = documentWith("<p>x x x x x</p>");
    const result = findInRenderedText(root, "x", false, 3);
    expect(result.ranges).toHaveLength(3);
    expect(result.capped).toBe(true);
    expect(findInRenderedText(root, "x", false, 5).capped).toBe(false);
  });

  it("finds nothing for a blank query", () => {
    const root = documentWith("<p>a b</p>");
    expect(buildFindPattern("   ", false)).toBeNull();
    expect(found(root, " ")).toEqual([]);
  });
});

describe("selectionSeed", () => {
  it("seeds from a short selection inside the document only", () => {
    const root = documentWith("<p>Every store in the renderer</p>");
    const outside = documentWith("<p>elsewhere</p>");
    const select = (node: Node, start: number, end: number) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    };

    select(root.querySelector("p")!.firstChild!, 6, 11);
    expect(selectionSeed(root)).toBe("store");

    select(outside.querySelector("p")!.firstChild!, 0, 9);
    expect(selectionSeed(root)).toBeNull();
  });
});

/** A registry entry that counts its writes; every write restyles the matches it holds. */
class CountingHighlight extends Set<Range> {
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

function stubHighlights() {
  const registry = new Map<string, CountingHighlight>();
  const media = { forced: false };
  stubGlobal("CSS", { highlights: registry });
  stubGlobal("Highlight", CountingHighlight);
  stubGlobal("matchMedia", () => ({ matches: media.forced }));
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
  };
}

describe("createFindPainter", () => {
  const painted = (highlight: Set<Range>, ranges: Range[]) =>
    ranges.map((range) => highlight.has(range));

  it("moves only the old and new current match when stepping through the same matches", () => {
    const highlights = stubHighlights();
    const root = documentWith("<p>store store store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, 0);
    highlights.resetCounts();

    painter.paint(ranges, 1);

    expect(painted(highlights.matches(), ranges)).toEqual([true, false, true, true]);
    expect([...highlights.current()]).toEqual([ranges[1]]);
    expect(highlights.matches().adds).toBe(1);
    expect(highlights.matches().deletes).toBe(1);
    expect(highlights.current().adds).toBe(1);
    expect(highlights.current().deletes).toBe(1);

    painter.paint(ranges, 3);
    painter.paint(ranges, 0);
    expect(painted(highlights.matches(), ranges)).toEqual([false, true, true, true]);
    expect([...highlights.current()]).toEqual([ranges[0]]);

    highlights.resetCounts();
    painter.paint(ranges, 0);
    expect(highlights.matches().adds + highlights.matches().deletes).toBe(0);
    expect(highlights.current().adds + highlights.current().deletes).toBe(0);
  });

  it("moves only the range that exists when stepping to or from no current match", () => {
    const highlights = stubHighlights();
    const root = documentWith("<p>store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, -1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, true]);
    highlights.resetCounts();

    painter.paint(ranges, 1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, false]);
    expect([...highlights.current()]).toEqual([ranges[1]]);
    expect(highlights.matches().adds).toBe(0);
    expect(highlights.current().deletes).toBe(0);

    painter.paint(ranges, -1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, true]);
    expect(highlights.current().size).toBe(0);
  });

  it("repaints the same matches in full after a clear or a replaced registry entry", () => {
    const highlights = stubHighlights();
    const root = documentWith("<p>store store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, 0);

    // StrictMode replays effects: the unmount cleanup clears, then the paint runs again.
    painter.clear();
    expect(highlights.matches().size + highlights.current().size).toBe(0);
    painter.paint(ranges, 0);
    expect(painted(highlights.matches(), ranges)).toEqual([false, true, true]);
    expect([...highlights.current()]).toEqual([ranges[0]]);

    const replaced = highlights.matches();
    highlights.replace(FIND_MATCH_HIGHLIGHT);
    painter.paint(ranges, 1);
    expect(replaced.size).toBe(0);
    expect(painted(highlights.matches(), ranges)).toEqual([true, false, true]);
    expect([...highlights.current()]).toEqual([ranges[1]]);
  });

  it("repaints in full when the matches change", () => {
    const highlights = stubHighlights();
    const root = documentWith("<p>store store state</p>");
    const before = findInRenderedText(root, "store", false).ranges;
    const painter = createFindPainter();
    painter.paint(before, 1);

    const after = findInRenderedText(root, "st", false).ranges;
    painter.paint(after, 0);

    expect(painted(highlights.matches(), before)).toEqual([false, false]);
    expect(painted(highlights.matches(), after)).toEqual([false, true, true]);
    expect([...highlights.current()]).toEqual([after[0]]);
  });

  it("paints only the current match under forced colours, and the rest again when they end", () => {
    const highlights = stubHighlights();
    const root = documentWith("<p>store store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    highlights.media.forced = true;
    painter.paint(ranges, 0);
    painter.paint(ranges, 1);
    expect(highlights.matches().size).toBe(0);
    expect([...highlights.current()]).toEqual([ranges[1]]);

    highlights.media.forced = false;
    painter.paint(ranges, 1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, false, true]);

    highlights.media.forced = true;
    painter.paint(ranges, 1);
    expect(highlights.matches().size).toBe(0);
    expect([...highlights.current()]).toEqual([ranges[1]]);
  });

  it("leaves another open find's matches alone", () => {
    const highlights = stubHighlights();
    const left = findInRenderedText(documentWith("<p>store store</p>"), "store", false).ranges;
    const right = findInRenderedText(documentWith("<p>store store</p>"), "store", false).ranges;
    const leftPainter = createFindPainter();
    const rightPainter = createFindPainter();
    leftPainter.paint(left, 0);
    rightPainter.paint(right, 0);

    leftPainter.paint(left, 1);
    expect(painted(highlights.matches(), right)).toEqual([false, true]);
    expect(painted(highlights.current(), right)).toEqual([true, false]);

    leftPainter.clear();
    expect([...highlights.matches()]).toEqual([right[1]]);
    expect([...highlights.current()]).toEqual([right[0]]);
  });
});

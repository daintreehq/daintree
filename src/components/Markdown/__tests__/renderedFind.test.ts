// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIND_CURRENT_HIGHLIGHT,
  FIND_MATCH_HIGHLIGHT,
  buildFindPattern,
  createFindPainter,
  createRenderedTextIndex,
  findInRenderedText,
  selectionSeed,
  type RenderedTextIndex,
} from "../renderedFind";
import { restoreFindHighlights, sole, stubFindHighlights } from "./findHighlightStub";

function documentWith(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function found(root: HTMLElement, query: string, matchCase = false, limit?: number): string[] {
  return findInRenderedText(root, query, matchCase, limit).ranges.map((range) => range.toString());
}

afterEach(() => {
  try {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  } finally {
    restoreFindHighlights();
  }
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

describe("createRenderedTextIndex", () => {
  const indexes: RenderedTextIndex[] = [];
  afterEach(() => {
    for (const index of indexes.splice(0)) index.dispose();
  });

  function indexOf(root: HTMLElement, onChange?: () => void) {
    const index = createRenderedTextIndex(root, onChange);
    indexes.push(index);
    // jsdom's selector engine makes walkers too, without a filter.
    const walkers = vi.spyOn(document, "createTreeWalker");
    const textWalks = () => walkers.mock.calls.filter((call) => call[2] != null).length;
    const find = (query: string, matchCase = false) =>
      index.find(query, matchCase).ranges.map((range) => range.toString());
    return { index, textWalks, find };
  }

  // The observer's records arrive in a microtask; a search later in the same
  // task reads them itself.
  const delivered = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  it("walks a stable document once across queries and case", () => {
    const root = documentWith("<p>A <strong>Zu</strong>stand store.</p><p>Store</p>");
    const { textWalks, find } = indexOf(root);
    expect(find("zustand")).toEqual(["Zustand"]);
    expect(find("store")).toEqual(["store", "Store"]);
    expect(find("Store", true)).toEqual(["Store"]);
    expect(find("storefamilies")).toEqual([]);
    expect(textWalks()).toBe(1);
  });

  it("does not walk the document for a blank query", () => {
    const { textWalks, find } = indexOf(documentWith("<p>store</p>"));
    expect(find("  ")).toEqual([]);
    expect(textWalks()).toBe(0);
  });

  it("keeps offsets across inline markup on a reused index", () => {
    const root = documentWith("<p>use <code>Panel</code><em>Store</em> here</p>");
    const { index, find } = indexOf(root);
    find("here");
    const [range] = index.find("panelstore", false).ranges;
    expect(range!.startContainer).toBe(root.querySelector("code")!.firstChild);
    expect(range!.startOffset).toBe(0);
    expect(range!.endContainer).toBe(root.querySelector("em")!.firstChild);
    expect(range!.endOffset).toBe(5);
  });

  it.each([
    ["in the same task", false],
    ["after the observer has run", true],
  ])("rebuilds after text changes %s", async (_when, deliver) => {
    // Awaiting anything at all would let the observer run first.
    const root = documentWith("<p><em>store</em></p><pre><code>usePanelStore</code></pre>");
    const { index, textWalks, find } = indexOf(root);
    expect(find("store")).toEqual(["store", "Store"]);

    // Shorter than the match the stale index would place in it.
    root.querySelector("em")!.firstChild!.textContent = "st";
    if (deliver) await delivered();
    expect(find("store")).toEqual(["Store"]);

    // A highlighter landing replaces the code block's text with the same text in spans.
    const code = root.querySelector("code")!;
    code.innerHTML = '<span class="k">use</span>PanelStore';
    if (deliver) await delivered();
    const [range] = index.find("usepanelstore", false).ranges;
    expect(range!.startContainer).toBe(code.querySelector("span")!.firstChild);
    expect(range!.endContainer).toBe(code.lastChild);
    expect(range!.endOffset).toBe(10);
    expect(textWalks()).toBe(3);
  });

  it.each([
    ["hidden", (el: HTMLElement) => el.setAttribute("hidden", "")],
    ["aria-hidden", (el: HTMLElement) => el.setAttribute("aria-hidden", "true")],
    ["sr-only", (el: HTMLElement) => el.classList.add("sr-only")],
  ])("follows text the %s attribute hides and shows again", async (_name, hide) => {
    const root = documentWith("<p>store <span>store</span></p>");
    const { find } = indexOf(root);
    const span = root.querySelector("span")!;
    expect(find("store")).toHaveLength(2);

    hide(span);
    expect(find("store")).toHaveLength(1);

    span.removeAttribute("hidden");
    span.removeAttribute("aria-hidden");
    span.classList.remove("sr-only");
    await delivered();
    expect(find("store")).toHaveLength(2);
  });

  it("rebuilds when a block boundary moves", () => {
    const root = documentWith("<p>store families</p>");
    const { find } = indexOf(root);
    expect(find("store families")).toEqual(["store families"]);

    const p = root.querySelector("p")!;
    p.textContent = "store";
    const next = document.createElement("p");
    next.textContent = "families";
    p.after(next);
    expect(find("store families")).toEqual([]);
    expect(find("families")).toEqual(["families"]);
  });

  it("lets go of the document on dispose and still searches it fresh", async () => {
    const root = documentWith("<p>store</p>");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const onChange = vi.fn();
    const { index, textWalks, find } = indexOf(root, onChange);
    find("store");
    index.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);

    root.querySelector("p")!.append(" store");
    expect(find("store")).toEqual(["store", "store"]);
    root.querySelector("p")!.append(" store");
    expect(find("store")).toEqual(["store", "store", "store"]);
    expect(textWalks()).toBe(3);
    await delivered();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tells its owner about changes it has not already searched past", async () => {
    const root = documentWith("<p>store</p>");
    const onChange = vi.fn();
    const { find } = indexOf(root, onChange);
    find("store");

    root.querySelector("p")!.append(" store");
    await delivered();
    expect(onChange).toHaveBeenCalledTimes(1);

    // Searched in the same task: that search already read the change.
    root.querySelector("p")!.append(" store");
    expect(find("store")).toHaveLength(3);
    await delivered();
    expect(onChange).toHaveBeenCalledTimes(1);
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

describe("createFindPainter", () => {
  const painted = (highlight: Set<Range>, ranges: Range[]) =>
    ranges.map((range) => highlight.has(range));
  const writes = (highlight: { adds: number; deletes: number }) => ({
    adds: highlight.adds,
    deletes: highlight.deletes,
  });

  it("moves only the old and new current match when stepping through the same matches", () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<p>store store store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, 0);
    highlights.resetCounts();

    painter.paint(ranges, 1);

    expect(painted(highlights.matches(), ranges)).toEqual([true, false, true, true]);
    expect(sole(highlights.current())).toBe(ranges[1]);
    expect(writes(highlights.matches())).toEqual({ adds: 1, deletes: 1 });
    expect(writes(highlights.current())).toEqual({ adds: 1, deletes: 1 });

    painter.paint(ranges, 3);
    painter.paint(ranges, 0);
    expect(painted(highlights.matches(), ranges)).toEqual([false, true, true, true]);
    expect(sole(highlights.current())).toBe(ranges[0]);

    highlights.resetCounts();
    painter.paint(ranges, 0);
    expect(writes(highlights.matches())).toEqual({ adds: 0, deletes: 0 });
    expect(writes(highlights.current())).toEqual({ adds: 0, deletes: 0 });
  });

  it("moves only the range that exists when stepping to or from no current match", () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<p>store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, -1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, true]);
    highlights.resetCounts();

    painter.paint(ranges, 1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, false]);
    expect(sole(highlights.current())).toBe(ranges[1]);
    expect(writes(highlights.matches())).toEqual({ adds: 0, deletes: 1 });
    expect(writes(highlights.current())).toEqual({ adds: 1, deletes: 0 });

    highlights.resetCounts();
    painter.paint(ranges, -1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, true]);
    expect(highlights.current().size).toBe(0);
    expect(writes(highlights.matches())).toEqual({ adds: 1, deletes: 0 });
    expect(writes(highlights.current())).toEqual({ adds: 0, deletes: 1 });
  });

  it("repaints in full when the matches change", () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<p>store store state</p>");
    const before = findInRenderedText(root, "store", false).ranges;
    const painter = createFindPainter();
    painter.paint(before, 1);

    const after = findInRenderedText(root, "st", false).ranges;
    painter.paint(after, 0);

    expect(painted(highlights.matches(), before)).toEqual([false, false]);
    expect(painted(highlights.current(), before)).toEqual([false, false]);
    expect(painted(highlights.matches(), after)).toEqual([false, true, true]);
    expect(sole(highlights.current())).toBe(after[0]);
  });

  it("paints only the current match under forced colours, and the rest again when they end", () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<p>store store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    highlights.media.forced = true;
    painter.paint(ranges, 0);
    highlights.resetCounts();
    painter.paint(ranges, 1);
    expect(highlights.matches().size).toBe(0);
    expect(writes(highlights.matches())).toEqual({ adds: 0, deletes: 0 });
    expect(sole(highlights.current())).toBe(ranges[1]);

    highlights.media.forced = false;
    painter.paint(ranges, 1);
    expect(painted(highlights.matches(), ranges)).toEqual([true, false, true]);
    expect(sole(highlights.current())).toBe(ranges[1]);

    highlights.media.forced = true;
    painter.paint(ranges, 1);
    expect(highlights.matches().size).toBe(0);
    expect(sole(highlights.current())).toBe(ranges[1]);
  });

  it("repaints the same matches in full after a clear", () => {
    const highlights = stubFindHighlights();
    const root = documentWith("<p>store store store</p>");
    const { ranges } = findInRenderedText(root, "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, 0);

    // StrictMode replays effects: the unmount cleanup clears, then the paint runs again.
    painter.clear();
    expect(highlights.matches().size + highlights.current().size).toBe(0);
    painter.paint(ranges, 0);
    expect(painted(highlights.matches(), ranges)).toEqual([false, true, true]);
    expect(sole(highlights.current())).toBe(ranges[0]);
  });

  it.each([FIND_MATCH_HIGHLIGHT, FIND_CURRENT_HIGHLIGHT])(
    "repaints in full into a replaced %s entry and empties the one it replaced",
    (name) => {
      const highlights = stubFindHighlights();
      const root = documentWith("<p>store store store</p>");
      const { ranges } = findInRenderedText(root, "store", false);
      const painter = createFindPainter();
      painter.paint(ranges, 0);
      const detached = name === FIND_MATCH_HIGHLIGHT ? highlights.matches() : highlights.current();

      highlights.replace(name);
      painter.paint(ranges, 0);

      expect(detached.size).toBe(0);
      expect(painted(highlights.matches(), ranges)).toEqual([false, true, true]);
      expect(sole(highlights.current())).toBe(ranges[0]);
    }
  );

  it("clears from the entries it painted into, even once the Highlight API is gone", () => {
    const highlights = stubFindHighlights();
    const { ranges } = findInRenderedText(documentWith("<p>store store</p>"), "store", false);
    const painter = createFindPainter();
    painter.paint(ranges, 0);

    highlights.withdrawApi();
    painter.clear();

    expect(highlights.matches().size + highlights.current().size).toBe(0);
  });

  it("leaves another open find's matches alone", () => {
    const highlights = stubFindHighlights();
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
    expect(sole(highlights.matches())).toBe(right[1]);
    expect(sole(highlights.current())).toBe(right[0]);
  });
});

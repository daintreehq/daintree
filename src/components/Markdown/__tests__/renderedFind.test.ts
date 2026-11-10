// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildFindPattern, findInRenderedText, selectionSeed } from "../renderedFind";

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
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMarkdownTarget, followMarkdownFragment } from "../renderedMarkdownAnchors";

function documentIn(pane: HTMLElement, html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  pane.appendChild(root);
  return root;
}

/** A pane that scrolls; jsdom has no layout, so its geometry is stubbed. */
function pane(top: number, borderTop = 0): HTMLElement {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 4000 });
  Object.defineProperty(element, "clientTop", { configurable: true, value: borderTop });
  element.getBoundingClientRect = () => ({ top }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function placeAt(element: Element | null, top: number): void {
  if (!element) throw new Error("no element to place");
  element.getBoundingClientRect = () => ({ top }) as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findMarkdownTarget (#17335)", () => {
  it("skips ids inside a diagram's SVG, HTML labels included", () => {
    const root = documentIn(
      pane(0),
      `<svg><g id="user-content-risks"></g><foreignObject><div id="user-content-risks">label</div></foreignObject></svg>
       <h2 id="user-content-risks">Risks</h2>`
    );

    expect(findMarkdownTarget(root, "#risks")?.tagName).toBe("H2");
    root.querySelector("h2")!.remove();
    expect(findMarkdownTarget(root, "#risks")).toBeNull();
  });

  it("ignores ids the pipeline did not mint", () => {
    const root = documentIn(pane(0), `<h2 id="risks">Risks</h2><div id="footnote-label"></div>`);

    expect(findMarkdownTarget(root, "#risks")).toBeNull();
    expect(findMarkdownTarget(root, "#footnote-label")).toBeNull();
  });

  it("prefers the prefixed reading of a fragment that already carries the prefix", () => {
    const root = documentIn(
      pane(0),
      `<p><a id="user-content-fn-note" href="#">note</a></p>
       <h2 id="user-content-user-content-fn-note">user-content-fn-note</h2>`
    );

    expect(findMarkdownTarget(root, "#user-content-fn-note")?.tagName).toBe("H2");
  });
});

describe("followMarkdownFragment (#17335)", () => {
  it("measures from inside the pane's border", () => {
    const scroller = pane(100, 4);
    const root = documentIn(scroller, `<h2 id="user-content-risks">Risks</h2>`);
    placeAt(root.querySelector("h2"), 100 + 4 + 600);

    expect(followMarkdownFragment(root, "#risks")).toBe(true);
    expect(scroller.scrollTop).toBe(592);
  });

  it("never scrolls above the top of the pane", () => {
    const scroller = pane(0);
    const root = documentIn(scroller, `<h1 id="user-content-plan">Plan</h1>`);
    placeAt(root.querySelector("h1"), 0);

    followMarkdownFragment(root, "#plan");

    expect(scroller.scrollTop).toBe(0);
  });

  it("focuses the target without letting the browser scroll it again", () => {
    const scroller = pane(0);
    const root = documentIn(scroller, `<h2 id="user-content-risks">Risks</h2>`);
    const heading = root.querySelector("h2")!;
    placeAt(heading, 700);
    const focus = vi.spyOn(heading, "focus");

    followMarkdownFragment(root, "#risks");

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(heading);
  });

  it("leaves a target's own tabindex alone", () => {
    const root = documentIn(pane(0), `<h2 id="user-content-risks" tabindex="-2">Risks</h2>`);

    followMarkdownFragment(root, "#risks");

    expect(root.querySelector("h2")!.getAttribute("tabindex")).toBe("-2");
  });

  it("reports a link that names nothing, and moves nothing", () => {
    const scroller = pane(0);
    const root = documentIn(scroller, `<h2 id="user-content-risks">Risks</h2>`);
    placeAt(root.querySelector("h2"), 700);

    expect(followMarkdownFragment(root, "#nowhere")).toBe(false);
    expect(scroller.scrollTop).toBe(0);
    expect(document.activeElement).toBe(document.body);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_CONTEXT_LIMITS,
  elementContextOf,
  markupFor,
  selectorFor,
  stylesFor,
} from "../guest/elementContext.js";
import { ELEMENT_CONTEXT_LIMITS, ElementContextSchema } from "../../shared/protocol.js";

function mountHtml(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): Element {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`no #${id}`);
  return node;
}

/** Computed styles as a table, per element: what Chromium would answer for each. */
function computedStyles(table: Map<Element, Record<string, string>>): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (element: Element) =>
      ({
        getPropertyValue: (property: string) => table.get(element)?.[property] ?? "",
      }) as CSSStyleDeclaration
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the guest's element context", () => {
  it("is built to the ceilings the host enforces", () => {
    // The guest can't import the zod module the host validates with, so the
    // two spellings of each ceiling are held together here.
    expect(GUEST_CONTEXT_LIMITS).toEqual(ELEMENT_CONTEXT_LIMITS);
  });

  it("stops as soon as the chain names one element", () => {
    mountHtml(
      '<section><button class="cta">One</button></section><section><button class="cta">Two</button></section>'
    );
    const second = document.querySelectorAll("button")[1]!;
    const selector = selectorFor(second);
    expect(selector).toBe("section:nth-of-type(2) > button.cta");
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(second);
  });

  it("anchors at the nearest unique id rather than walking to the root", () => {
    mountHtml('<div id="card"><span>In</span></div><div><span>Out</span></div>');
    const inside = document.querySelector("#card span")!;
    expect(selectorFor(inside)).toBe("#card > span");
  });

  it("leaves build-generated class names out of the selector", () => {
    mountHtml('<div><p class="svelte-1x2y3z card css-9ab8cd text-[13px]">Hi</p></div>');
    expect(selectorFor(document.querySelector("p")!)).toBe("p.card");
  });

  it("keeps field values, embedded payloads, handlers and script bodies out of the markup", () => {
    mountHtml(
      [
        '<form id="f" onsubmit="steal()">',
        '<input type="password" value="hunter2">',
        "<textarea>my private note</textarea>",
        '<img src="data:image/png;base64,AAAA">',
        "<script>window.secret = 1</script>",
        "</form>",
      ].join("")
    );
    const { markup } = markupFor(byId("f"));
    expect(markup).not.toContain("hunter2");
    expect(markup).not.toContain("my private note");
    expect(markup).not.toContain("AAAA");
    expect(markup).not.toContain("steal");
    expect(markup).not.toContain("window.secret");
    expect(markup).toContain('value="[redacted]"');
    expect(markup).toContain('src="data:…"');
  });

  it("keeps what the user typed or chose out, wherever it lives", () => {
    mountHtml(
      [
        '<div id="f">',
        '<div contenteditable="true"><p>my private note</p></div>',
        '<select><option selected value="acct-12345">Personal</option></select>',
        '<input type="checkbox" checked>',
        "</div>",
      ].join("")
    );
    const { markup } = markupFor(byId("f"));
    expect(markup).not.toContain("my private note");
    expect(markup).not.toContain("acct-12345");
    expect(markup).not.toContain("Personal");
    expect(markup).toContain('checked="[redacted]"');
    // Selecting inside the editable region is no way round it.
    expect(markupFor(document.querySelector("[contenteditable] p")!).markup).not.toContain(
      "my private note"
    );
  });

  it("shows an attribute that may hold a credential without copying its value", () => {
    mountHtml(
      [
        '<div id="f" data-token="s3cret-token" nonce="n0nce">',
        '<a href="https://user:pw@example.com/reset?token=s3cret-token&amp;step=2#access=s3cret-token">Reset</a>',
        '<span style="background: url(data:image/svg+xml,s3cret-token)">x</span>',
        "</div>",
      ].join("")
    );
    const { markup } = markupFor(byId("f"));
    expect(markup).not.toContain("s3cret-token");
    expect(markup).not.toContain("n0nce");
    expect(markup).not.toContain("pw@");
    expect(markup).toContain('data-token="…"');
    expect(markup).toContain('href="https://example.com/reset?token=&amp;step=#access="');
  });

  it("redacts a client-side router's query, and keeps every candidate of a srcset", () => {
    mountHtml(
      '<div id="f"><a href="#/reset?token=s3cret">Reset</a><img srcset="sprite.svg#icon 1x, photo.png?sig=s3cret 2x"></div>'
    );
    const { markup } = markupFor(byId("f"));
    expect(markup).not.toContain("s3cret");
    expect(markup).toContain('href="#/reset?token="');
    expect(markup).toContain('srcset="sprite.svg#icon 1x, photo.png?sig= 2x"');
  });

  it("withholds a style that could spell an address, however it is written", () => {
    mountHtml(
      [
        '<div id="f">',
        '<span style="background: url(&quot;https://cdn.example/a)icon.png?token=s3cret&quot;)">a</span>',
        '<span style="background: u\\72l(https://cdn.example/?token=s3cret)">b</span>',
        "</div>",
      ].join("")
    );
    expect(markupFor(byId("f")).markup).not.toContain("s3cret");
  });

  it("bounds the work a hostile attribute can cause, not just the output", () => {
    mountHtml(`<a id="a" href="/x${"?".repeat(200_000)}">x</a>`);
    const { markup } = markupFor(byId("a"));
    expect(markup.length).toBeLessThan(400);
  });

  it("treats an SVG's script and style as payloads, as HTML's are", () => {
    mountHtml(
      '<svg id="s" xmlns="http://www.w3.org/2000/svg"><style>.a{}/* s3cret */</style><script>s3cret()</script><g/></svg>'
    );
    expect(markupFor(byId("s")).markup).not.toContain("s3cret");
  });

  it("finds a node inside a shadow root by the tree it is actually in", () => {
    // A document query can't see into the root at all, so it never calls
    // anything unique and the selector used to run on to its depth limit.
    mountHtml('<div id="host"></div>');
    const shadow = byId("host").attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<section><button class="cta">One</button></section><section><button class="cta">Two</button></section>';
    const second = shadow.querySelectorAll("button")[1]!;
    const selector = selectorFor(second);
    expect(selector).toBe("section:nth-of-type(2) > button.cta");
    expect(shadow.querySelector(selector)).toBe(second);
  });

  it("drops whole leading steps to fit a long selector, never cutting one in half", () => {
    // Two identical trees deeper than the selector walks: no chain of eight
    // steps names one leaf, and eight steps of long classes run past the cap.
    const long = "a".repeat(38);
    let tree = "<p>x</p>";
    for (let depth = 0; depth < 10; depth += 1) {
      tree = `<div class="${long}b${depth} ${long}c${depth}">${tree}</div>`;
    }
    mountHtml(tree + tree);
    const selector = selectorFor(document.querySelector("p")!);
    expect(selector.length).toBeLessThanOrEqual(GUEST_CONTEXT_LIMITS.selector);
    expect(selector).not.toContain("…");
    expect(selector.split(" > ").length).toBeGreaterThan(1);
    expect(document.querySelectorAll(selector).length).toBeGreaterThan(0);
  });

  it("cuts the markup at its ceiling and says it did", () => {
    const attributes = ["title", "alt", "placeholder", "aria-label", "aria-description"].map(
      (name) => `${name}="${"v".repeat(150)}"`
    );
    const items = Array.from({ length: 12 }, () => `<li ${attributes.join(" ")}>item</li>`);
    mountHtml(`<ul id="list">${items.join("")}</ul>`);
    const { markup, truncated } = markupFor(byId("list"));
    expect(truncated).toBe(true);
    expect(markup.length).toBe(GUEST_CONTEXT_LIMITS.markup);
  });

  it("drops inherited values the parent already has, and own values at their defaults", () => {
    mountHtml('<div id="parent"><p id="child">Hi</p></div>');
    const parent = byId("parent");
    const child = byId("child");
    computedStyles(
      new Map<Element, Record<string, string>>([
        [parent, { color: "rgb(0, 0, 0)", "font-size": "16px", margin: "12px" }],
        [
          child,
          {
            display: "block",
            color: "rgb(0, 0, 0)",
            "font-size": "20px",
            // A child's margin is its own: matching the parent's says nothing.
            margin: "12px",
            padding: "0px 0px 0px 0px",
            position: "static",
            opacity: "1",
            "border-style": "none",
            "border-color": "rgb(0, 0, 0)",
          },
        ],
      ])
    );
    const styles = Object.fromEntries(
      stylesFor(child).map((entry) => [entry.property, entry.value])
    );
    expect(styles).toEqual({ display: "block", "font-size": "20px", margin: "12px" });
  });

  it("empties every url() in a computed value: an embedded payload or a tokened address", () => {
    mountHtml('<div id="parent"><p id="child">Hi</p></div>');
    computedStyles(
      new Map<Element, Record<string, string>>([
        [byId("parent"), {}],
        [
          byId("child"),
          {
            "background-image": 'url("data:image/svg+xml,s3cret")',
            cursor: "url(https://cdn.example/c.png?sig=s3cret), auto",
          },
        ],
      ])
    );
    const styles = stylesFor(byId("child"));
    expect(JSON.stringify(styles)).not.toContain("s3cret");
    expect(styles).toContainEqual({ property: "background-image", value: "url(…)" });
  });

  it("produces what the host's schema accepts, even for a hostile page", () => {
    const hostile = "x".repeat(5_000);
    mountHtml(`<div id="${hostile}" class="${hostile}" title="${hostile}">${hostile}</div>`);
    const context = elementContextOf(document.querySelector("div")!);
    expect(context).not.toBeNull();
    expect(ElementContextSchema.safeParse(context).success).toBe(true);
  });

  it("gives up quietly when the page has broken the DOM it reads", () => {
    mountHtml('<p id="p">Hi</p>');
    const node = byId("p");
    Object.defineProperty(node, "attributes", {
      get() {
        throw new Error("page broke it");
      },
    });
    expect(elementContextOf(node)).toBeNull();
  });
});

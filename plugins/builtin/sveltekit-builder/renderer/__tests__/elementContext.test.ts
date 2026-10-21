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

  it("cuts the markup at its ceiling and says it did", () => {
    const attributes = Array.from({ length: 6 }, (_, i) => `data-a${i}="${"v".repeat(150)}"`);
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

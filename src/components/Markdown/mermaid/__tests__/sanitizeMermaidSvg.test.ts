// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import DOMPurify from "dompurify";
import { sanitizeMermaidSvg } from "../sanitizeMermaidSvg";

const SVG_OPEN = '<svg id="m1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';

function sanitize(inner: string): string {
  const result = sanitizeMermaidSvg(DOMPurify, `${SVG_OPEN}${inner}</svg>`);
  if (result === null) throw new Error("expected an svg");
  return result;
}

function parse(markup: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  return holder;
}

describe("sanitizeMermaidSvg", () => {
  it("keeps ordinary diagram markup, local marker references and the scoped style block", () => {
    const out = parse(
      sanitize(
        "<style>#m1 .node rect{fill:#333;}</style>" +
          '<defs><marker id="m1_arrow"><path d="M0,0 L1,1"/></marker></defs>' +
          '<g class="node"><rect width="4" height="4" style="fill:#abc"/>' +
          '<text x="1" y="1">Start</text></g>' +
          '<path d="M0,0 L5,5" marker-end="url(#m1_arrow)"/>'
      )
    );
    const svg = out.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(out.querySelector("style")?.textContent).toContain("#m1 .node rect");
    expect(out.querySelector("text")?.textContent).toBe("Start");
    expect(out.querySelector("rect")?.getAttribute("style")).toBe("fill:#abc");
    expect(out.querySelector("path[marker-end]")?.getAttribute("marker-end")).toBe(
      "url(#m1_arrow)"
    );
  });

  it("drops script elements and inline event handlers", () => {
    const out = parse(
      sanitize(
        "<script>window.pwned = 1</script>" +
          '<g onclick="window.pwned = 2"><rect onload="x()" onmouseover="y()" width="1"/></g>'
      )
    );
    expect(out.querySelector("script")).toBeNull();
    for (const element of out.querySelectorAll("*")) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith("on")).toBe(false);
      }
    }
  });

  it("unwraps links so a click can never navigate the renderer, keeping their label", () => {
    const out = parse(
      sanitize(
        '<a href="javascript:alert(1)"><text>evil</text></a>' +
          '<a xlink:href="https://example.com"><text>remote</text></a>'
      )
    );
    expect(out.querySelector("a")).toBeNull();
    expect(out.textContent).toContain("evil");
    expect(out.textContent).toContain("remote");
    expect(out.innerHTML).not.toContain("javascript:");
    expect(out.innerHTML).not.toContain("example.com");
  });

  it("drops foreignObject HTML, images and animation that could rewrite attributes", () => {
    const out = parse(
      sanitize(
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"></div></foreignObject>' +
          '<image href="https://tracker.example/pixel.png"/>' +
          '<rect width="1"><set attributeName="onmouseover" to="alert(1)"/>' +
          '<animate attributeName="href" to="javascript:alert(1)"/></rect>'
      )
    );
    expect(out.querySelector("foreignObject, foreignobject")).toBeNull();
    expect(out.querySelector("img")).toBeNull();
    expect(out.querySelector("image")).toBeNull();
    expect(out.querySelector("set")).toBeNull();
    expect(out.querySelector("animate")).toBeNull();
  });

  it("drops <use>, which could pull in an external document", () => {
    const out = parse(sanitize('<use href="https://example.com/sprite.svg#icon"/>'));
    expect(out.querySelector("use")).toBeNull();
    expect(out.innerHTML).not.toContain("example.com");
  });

  it("drops external url(), @import and escaped CSS, keeping local references", () => {
    const out = parse(
      sanitize(
        '<style>@import url("https://evil.example/x.css");' +
          " #m1 .a{fill:url(https://evil.example/p.png);}" +
          " #m1 .b{fill:url(#m1_grad);}" +
          " #m1 .c{fill:u\\72l(https://evil.example/e.png);}" +
          " #m1 .d{background:image-set('https://evil.example/i.png' 1x);}</style>" +
          '<rect width="1" style="fill:url(\'https://evil.example/q.png\')"/>' +
          '<rect width="2" fill="url(https://evil.example/r.png)"/>'
      )
    );
    const css = out.querySelector("style")?.textContent ?? "";
    expect(css).not.toContain("evil.example");
    expect(css).not.toContain("@import");
    expect(css).toContain("url(");
    expect(css).toContain("m1_grad");
    expect(out.innerHTML).not.toContain("evil.example");
    expect(out.querySelectorAll("rect")).toHaveLength(2);
  });

  it("keeps only style rules scoped under the diagram's own id", () => {
    const out = parse(
      sanitize(
        "<style>#m1 .node{fill:#111;}" +
          " #m1{font-family:sans-serif;}" +
          " #m1 .x, body{display:none;}" +
          " .toolbar{display:none;}" +
          " #m10 .y{fill:#222;}" +
          " @keyframes m1-dash{to{stroke-dashoffset:0;}}</style>"
      )
    );
    const css = out.querySelector("style")?.textContent ?? "";
    expect(css).toContain(".node");
    expect(css).toContain("font-family");
    expect(css).toContain("@keyframes");
    expect(css).not.toContain("body");
    expect(css).not.toContain(".toolbar");
    expect(css).not.toContain("#m10");
  });

  it("returns null when the output is not a single svg root", () => {
    expect(sanitizeMermaidSvg(DOMPurify, "<div>nope</div>")).toBeNull();
    expect(sanitizeMermaidSvg(DOMPurify, "")).toBeNull();
    expect(sanitizeMermaidSvg(DOMPurify, `${SVG_OPEN}</svg>${SVG_OPEN}</svg>`)).toBeNull();
    // Without a usable root id there is nothing to scope the diagram's CSS to.
    expect(
      sanitizeMermaidSvg(DOMPurify, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    ).toBeNull();
  });
});

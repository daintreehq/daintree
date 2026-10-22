import { describe, expect, it } from "vitest";
import { checkAstroAnchor, lexiconOf } from "../worker/resolvers/astroSource.js";

/** `line:column` as `data-astro-source-loc` carries it. */
function check(source: string, loc: string, tagName: string) {
  const [line, column] = loc.split(":").map(Number) as [number, number];
  return checkAstroAnchor(source, line, column, tagName);
}

describe("checkAstroAnchor", () => {
  // Each source and position is one `@astrojs/compiler-rs` stamps in its own
  // tests (crates/astro_codegen/tests/annotation.rs and the source_annotations
  // snapshot), so these are the compiler's answers, not this checker's.
  it.each([
    ["<h1>Hello</h1>", "1:5", "h1"],
    ["<div>{value}</div>", "1:6", "div"],
    ["<div><>x</></div>", "1:6", "div"],
    ["<p>  Hello</p>", "1:4", "p"],
    ["<p> \n  </p>", "1:4", "p"],
    ["😀<span>first</span>\n  <div>second</div>", "1:9", "span"],
    ["😀<span>first</span>\n  <div>second</div>", "2:8", "div"],
    ["<div><span>x</span></div><p></p><aside><!-- c -->x</aside>", "1:7", "div"],
    ["<div><span>x</span></div><p></p><aside><!-- c -->x</aside>", "1:12", "span"],
    ["<div><span>x</span></div><p></p><aside><!-- c -->x</aside>", "1:27", "p"],
    ["<div><span>x</span></div><p></p><aside><!-- c -->x</aside>", "1:44", "aside"],
    ["<div>\r\n  text</div>\r\n<span />", "1:6", "div"],
    ["<div>\r\n  text</div>\r\n<span />", "3:2", "span"],
    ["<my-element>Hi</my-element>", "1:2", "my-element"],
    ["<div>Hello <span>{value}</span></div>\n<my-element/>", "1:6", "div"],
    ["<div>Hello <span>{value}</span></div>\n<my-element/>", "1:18", "span"],
    ["<div>Hello <span>{value}</span></div>\n<my-element/>", "2:2", "my-element"],
  ])("verifies %j at %s for <%s>", (source, loc, tagName) => {
    expect(check(source, loc, tagName)).toBe("verified");
  });

  it("verifies a void element, a multi-line opening tag and one with `>` inside an expression", () => {
    expect(check('<img src="a.png">', "1:2", "img")).toBe("verified");
    expect(check('<div\n  class="a"\n>\n  Hi\n</div>', "3:2", "div")).toBe("verified");
    expect(check('<div class={a > b ? "x" : "y"}>Hi</div>', "1:32", "div")).toBe("verified");
    expect(check('<div data-x="<span>">Hello</div>', "1:22", "div")).toBe("verified");
  });

  it("verifies markup an expression renders, apostrophes in its text and all", () => {
    const source = "<ul>{items.map((item) => <li>It's {item}</li>)}</ul>";
    expect(check(source, `1:${source.indexOf("It's") + 1}`, "li")).toBe("verified");
    expect(check(source, "1:5", "ul")).toBe("verified");
  });

  it("verifies past frontmatter, and counts no tag inside it", () => {
    const source = '---\nconst s = "<p>x</p>";\n---\n<div>y</div>';
    expect(check(source, "4:6", "div")).toBe("verified");
    expect(check(source, "2:15", "p")).toBe("mismatch");
  });

  it("counts no tag inside a comment, a script or a style", () => {
    expect(check("<!-- <p>x</p> -->\n<p>y</p>", "1:9", "p")).toBe("mismatch");
    expect(check("<!-- <p>x</p> -->\n<p>y</p>", "2:4", "p")).toBe("verified");
    expect(check('<script>const a = "<p>x</p>";</script>', "1:23", "p")).toBe("mismatch");
    expect(check("<style>/* <p>x</p> */</style>", "1:14", "p")).toBe("mismatch");
  });

  it("refuses the element's own name where the compiler would have stamped its first child", () => {
    expect(check("<div>Hello</div>", "1:2", "div")).toBe("mismatch");
    expect(check("<my-el>Hi</my-el>", "1:8", "my-el")).toBe("mismatch");
  });

  it("skips nothing to make a position fit", () => {
    expect(check("<div>   Hello</div>", "1:9", "div")).toBe("mismatch");
    expect(check("<div>\n  <p>x</p>\n</div>", "2:4", "div")).toBe("mismatch");
  });

  it("refuses a later child, a tag inside an attribute, and a longer name with the same start", () => {
    expect(check("<div><!--x--><span/></div>", "1:15", "div")).toBe("mismatch");
    expect(check("<div><!--x--><span/></div>", "1:15", "span")).toBe("verified");
    expect(check('<div data-x="<span>">Hello</div>', "1:22", "span")).toBe("mismatch");
    expect(check("<diversion>x</diversion>", "1:12", "div")).toBe("mismatch");
  });

  it("counts no tag inside another tag's quoted attribute", () => {
    expect(check('<div title="<p>x</p>">y</div>', "1:16", "p")).toBe("mismatch");
    expect(check('<div title="<p>x</p>">y</div>', "1:23", "div")).toBe("verified");
    expect(check('<div data-x="<span>">Hello</div>', "1:20", "span")).toBe("mismatch");
    expect(check('<div data-x="<br/>">Hello</div>', "1:15", "br")).toBe("mismatch");
  });

  it("leaves unsettled a tag that may sit in a string or an attribute expression", () => {
    expect(check('<div>{"<p>x</p>"}</div>', "1:11", "p")).toBe("inconclusive");
    expect(check("<div slot={<b>x</b>}>y</div>", "1:15", "b")).toBe("inconclusive");
  });

  it("follows attribute expressions a string-aware read cannot", () => {
    expect(check('<p a={/"/.test(s)}>x</p>', "1:20", "p")).toBe("verified");
    expect(check("<p a={<i>it's</i>}>x</p>", "1:20", "p")).toBe("verified");
    expect(check(`<p title="${"<".repeat(64)}">x</p>`, "1:77", "p")).toBe("verified");
  });

  it("reads a textarea's content as text, whatever it looks like", () => {
    expect(check("<textarea><b>x</b></textarea>", "1:11", "textarea")).toBe("verified");
    expect(check("<textarea><b>x</b></textarea>", "1:14", "b")).toBe("mismatch");
  });

  it("knows a script only by its own opening and closing tags", () => {
    expect(check("<!-- <script> -->\n<p>x</p>", "2:4", "p")).toBe("verified");
    expect(check('<script>const s="</scriptx><p>x</p>";</script>', "1:31", "p")).toBe("mismatch");
  });

  it("never verifies an element the compiler does not stamp", () => {
    expect(check("<html></html>", "1:2", "html")).toBe("mismatch");
    expect(check("<title>x</title>", "1:8", "title")).toBe("mismatch");
    expect(check("<Card>x</Card>", "1:7", "Card")).toBe("mismatch");
  });

  it("calls a check its bound cut short inconclusive, not a mismatch", () => {
    const long = `<p title="${"a".repeat(70 * 1024)}">x</p>`;
    expect(check(long, `1:${long.indexOf(">x") + 2}`, "p")).toBe("inconclusive");
  });

  it("finds an opening tag whose expression holds a brace in a string", () => {
    expect(check('<p data-x={"}"}>x</p>', "1:17", "p")).toBe("verified");
    expect(check('<p data-x={"{"}>x</p>', "1:17", "p")).toBe("verified");
  });

  it("looks for raw text only in markup", () => {
    expect(check('---\nconst s = "<textarea>";\n---\n<p>x</p>', "4:4", "p")).toBe("verified");
    expect(check('<script is:inline>const s = "<textarea>";</script><p>x</p>', "1:54", "p")).toBe(
      "verified"
    );
  });

  it("counts no tag in a quoted attribute however many `<`s come before it", () => {
    const source = `<div title="${"<".repeat(64)}<p>x</p>">ok</div>`;
    expect(check(source, "1:80", "p")).toBe("mismatch");
  });

  it("reads the content of an `is:raw` element as text", () => {
    expect(check("<pre is:raw><div>Hello</div></pre>", "1:13", "pre")).toBe("verified");
    expect(check("<pre is:raw><div>Hello</div></pre>", "1:18", "div")).toBe("mismatch");
    expect(check('<pre title="is:raw"><div>Hello</div></pre>', "1:22", "pre")).toBe("verified");
  });

  it("reads on past an expression a brace count or a string-aware read alone would lose", () => {
    const quotedBrace = "<code>{'{'}</code>\n<p>Next</p>";
    expect(check(quotedBrace, "1:7", "code")).toBe("verified");
    expect(check(quotedBrace, "2:4", "p")).toBe("verified");
    const apostrophe = "<ul>{items.map((item) => <li>It's {item}</li>)}</ul>\n<p>x</p>";
    expect(check(apostrophe, "2:4", "p")).toBe("verified");
  });

  it("reads a file once for every check in it", () => {
    const source = "<main>\n  <h1>Shop</h1>\n  <p>x</p>\n</main>";
    const lexicon = lexiconOf(source);
    expect(checkAstroAnchor(source, 2, 7, "h1", lexicon)).toBe("verified");
    expect(checkAstroAnchor(source, 3, 6, "p", lexicon)).toBe("verified");
    expect(checkAstroAnchor(source, 3, 6, "h1", lexicon)).toBe("mismatch");
  });

  it("refuses a position past the end of its line or its file", () => {
    expect(check("<h1>Hello</h1>", "1:16", "h1")).toBe("mismatch");
    expect(check("<h1>Hello</h1>", "2:1", "h1")).toBe("mismatch");
  });

  it("leaves unsettled what it cannot settle", () => {
    // Whether the compiler counted the mark depends on what handed it the text.
    expect(check("﻿<h1>Hello</h1>", "1:5", "h1")).toBe("inconclusive");
    expect(check("﻿<h1>Hello</h1>\n<p>x</p>", "2:4", "p")).toBe("verified");
    expect(check("---\nconst a = 1;\n<h1>Hello</h1>", "3:5", "h1")).toBe("inconclusive");
    // The DOM case-adjusts SVG names; the source may not have.
    expect(check("<svg><lineargradient>x</lineargradient></svg>", "1:22", "linearGradient")).toBe(
      "inconclusive"
    );
    expect(check("<svg><linearGradient>x</linearGradient></svg>", "1:22", "linearGradient")).toBe(
      "verified"
    );
  });
});

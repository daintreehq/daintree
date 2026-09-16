import { describe, expect, it } from "vitest";
import type { Definition } from "../../shared/model";
import { locateElementSource } from "../sourceShape";
import { sha } from "./testHost";

/** Build a definition + whole-line excerpt for the first `<tag` in `source`. */
function locate(source: string, tagName: string, contextLines = 0) {
  const start = source.indexOf(`<${tagName}`);
  const closing = `</${tagName}>`;
  const closeAt = source.indexOf(closing, start);
  const startTagEnd = source.indexOf(">", start) + 1;
  const end =
    closeAt === -1 || source.slice(startTagEnd - 2, startTagEnd) === "/>"
      ? startTagEnd
      : closeAt + closing.length;
  const before = source.slice(0, start);
  const line = before.split("\n").length;
  const column = start - (before.lastIndexOf("\n") + 1);
  const lines = source.split("\n");
  const endLine = source.slice(0, end).split("\n").length;
  const firstLine = Math.max(1, line - contextLines);
  const text = lines.slice(firstLine - 1, endLine + contextLines).join("\n");
  const definition: Definition = {
    location: { file: "src/x.svelte", line, column },
    range: { start, end },
    tagName,
    revision: sha(source),
    renderedOccurrences: 1,
  };
  return {
    source,
    definition,
    result: locateElementSource({ text, firstLine, revision: sha(source) }, definition),
  };
}

describe("locateElementSource", () => {
  it("maps a static class attribute and literal text back to absolute file offsets", () => {
    const source =
      '<div>\n  <p>x</p>\n  <button class="px-6  py-3" type="button"> Buy now </button>\n</div>\n';
    const { result } = locate(source, "button", 1);
    if (result.status !== "ok") throw new Error(result.status);
    const classes = result.shape.classes;
    if (classes.kind !== "static") throw new Error(classes.kind);
    expect(source.slice(classes.range.start, classes.range.end)).toBe("px-6  py-3");
    expect(classes.tokens).toEqual(["px-6", "py-3"]);
    const text = result.shape.text;
    if (text.kind !== "literal") throw new Error(text.kind);
    expect(source.slice(text.range.start, text.range.end)).toBe(" Buy now ");
    expect(text.leading + text.text + text.trailing).toBe(" Buy now ");
  });

  it("reads a start tag spanning lines whose expression attribute contains '>'", () => {
    const source = '<a\n  href={count > 1 ? "/many" : "/one"}\n  class="link">Go</a>\n';
    const { result } = locate(source, "a");
    if (result.status !== "ok") throw new Error(result.status);
    const classes = result.shape.classes;
    if (classes.kind !== "static") throw new Error(classes.kind);
    expect(source.slice(classes.range.start, classes.range.end)).toBe("link");
    expect(result.shape.text).toMatchObject({ kind: "literal", text: "Go" });
  });

  it("refuses a class value with an expression and text with markup or bindings", () => {
    const dynamic = locate(
      "<span class=\"a {active ? 'b' : ''}\">Hi <b>there</b></span>\n",
      "span"
    );
    if (dynamic.result.status !== "ok") throw new Error(dynamic.result.status);
    expect(dynamic.result.shape.classes.kind).toBe("dynamic");
    expect(dynamic.result.shape.text).toEqual({ kind: "none", reason: "nested-markup" });

    const bound = locate("<h1>Hello {name}</h1>\n", "h1");
    if (bound.result.status !== "ok") throw new Error(bound.result.status);
    expect(bound.result.shape.classes.kind).toBe("absent");
    expect(bound.result.shape.text).toEqual({ kind: "none", reason: "expression" });

    const entity = locate("<h2>Tom &amp; Jerry</h2>\n", "h2");
    if (entity.result.status !== "ok") throw new Error(entity.result.status);
    expect(entity.result.shape.text).toEqual({ kind: "none", reason: "entity" });
  });

  it("fails closed on attribute expressions it can't lex safely", () => {
    const regex = locate(
      '<button title={/}/.test(v) ? ">" : ""} class="px-4">Buy</button>\n',
      "button"
    );
    expect(regex.result).toEqual({ status: "unreadable" });
    const template = locate('<p title={`a ${b}`} class="x">Hi</p>\n', "p");
    expect(template.result).toEqual({ status: "unreadable" });
  });

  it("treats a self-closing element as having no text", () => {
    const { result } = locate('<img class="w-4" src="/a.png" />\n', "img");
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.shape.text).toEqual({ kind: "none", reason: "no-content" });
    expect(result.shape.classes.kind).toBe("static");
  });

  it("reports a revision mismatch instead of reading bytes from another version", () => {
    const { definition } = locate("<p>One</p>\n", "p");
    expect(
      locateElementSource(
        { text: "<p>Two</p>", firstLine: 1, revision: sha("<p>Two</p>\n") },
        definition
      )
    ).toEqual({ status: "revision-mismatch" });
  });

  it("refuses when the range doesn't start at the named tag", () => {
    const source = "<buttons>Nope</buttons>\n";
    const { definition } = locate(source, "buttons");
    const wrong = { ...definition, tagName: "button" };
    expect(
      locateElementSource({ text: source.trimEnd(), firstLine: 1, revision: sha(source) }, wrong)
    ).toEqual({ status: "unreadable" });
  });
});

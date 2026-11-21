// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { linkTargetAt, urlNodeHref } from "../markdownLinkTarget";

function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function hrefs(doc: string): (string | null)[] {
  const state = stateOf(doc);
  const found: (string | null)[] = [];
  ensureSyntaxTree(state, doc.length, 5000)!.iterate({
    enter: (node) => {
      if (node.name === "URL") found.push(urlNodeHref(state, node.node));
    },
  });
  return found;
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

describe("urlNodeHref", () => {
  it("reads bare URLs, autolinks and link destinations as the rendered document links them", () => {
    expect(
      hrefs(
        "https://bare.dev www.host.dev me@mail.dev <https://auto.dev> <you@mail.dev> [t](./a.md) ![i](img.png)\n"
      )
    ).toEqual([
      "https://bare.dev",
      "http://www.host.dev",
      "mailto:me@mail.dev",
      "https://auto.dev",
      "mailto:you@mail.dev",
      "./a.md",
      "img.png",
    ]);
  });

  it("gives a www. host its scheme whatever its path or port holds, and keeps a scheme's own", () => {
    expect(hrefs("www.x.dev/a@b www.x.dev:8080/a <https://x.dev/@me> <mailto:a@b.dev>\n")).toEqual([
      "http://www.x.dev/a@b",
      "http://www.x.dev:8080/a",
      "https://x.dev/@me",
      "mailto:a@b.dev",
    ]);
  });

  it("drops a destination's angle brackets and decodes its escapes and entities, as CommonMark does", () => {
    expect(
      hrefs(
        '[a](<./my doc.md>) [b](a\\_b\\(1\\).md "title") [c](x.md#h) [d](https://x.dev/?a=1&amp;b=2) [e](&#35;setup) [f](&#x41;.md) [g](\\&amp;) [h](&bogus;)\n'
      )
    ).toEqual([
      "./my doc.md",
      "a_b(1).md",
      "x.md#h",
      "https://x.dev/?a=1&b=2",
      "#setup",
      "A.md",
      "&amp;",
      "&bogus;",
    ]);
  });

  it("sends a URL written in a link's text where the link goes, and nowhere for a reference link", () => {
    expect(
      hrefs('[https://x.dev](./guide.md "t") [see https://y.dev][r]\n\n[r]: ./r.md\n')
    ).toEqual(["./guide.md", "./guide.md", null, "./r.md"]);
  });

  it("reads a link reference definition's destination without adding a scheme", () => {
    expect(hrefs("[ref]: www.not-bare.dev\n")).toEqual(["www.not-bare.dev"]);
  });
});

describe("linkTargetAt", () => {
  it("follows a link's destination from a URL written in its text", () => {
    const doc = "[https://x.dev](./guide.md)\n";
    view = new EditorView({ state: stateOf(doc), parent: document.body });
    expect(linkTargetAt(view, 3)).toBe("./guide.md");
    expect(linkTargetAt(view, doc.indexOf("guide"))).toBe("./guide.md");
  });
});

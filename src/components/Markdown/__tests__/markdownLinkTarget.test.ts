import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { urlNodeHref } from "../markdownLinkTarget";

function hrefs(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const tree = ensureSyntaxTree(state, doc.length, 5000)!;
  const found: string[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "URL") found.push(urlNodeHref(state, node.node));
    },
  });
  return found;
}

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

  it("drops a destination's angle brackets and backslash escapes, and keeps its fragment", () => {
    expect(hrefs('[a](<./my doc.md>) [b](a\\_b.md "title") [c](x.md#h)\n')).toEqual([
      "./my doc.md",
      "a_b.md",
      "x.md#h",
    ]);
  });

  it("reads a link reference definition's destination", () => {
    expect(hrefs("[ref]: www.not-bare.dev\n")).toEqual(["www.not-bare.dev"]);
  });
});

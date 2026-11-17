import { describe, expect, it } from "vitest";
import type { Element as HastElement, Root as HastRoot, RootContent } from "hast";
import { markdownFragmentIds, MARKDOWN_ID_PREFIX, rehypeHeadingIds } from "../headingIds";

function heading(tagName: string, ...children: HastElement["children"]): HastElement {
  return { type: "element", tagName, properties: {}, children };
}

const text = (value: string) => ({ type: "text" as const, value });

function ids(tree: HastRoot): unknown[] {
  rehypeHeadingIds()(tree);
  const found: unknown[] = [];
  const visit = (node: HastRoot | RootContent) => {
    if (node.type === "element" && /^h[1-6]$/.test(node.tagName)) found.push(node.properties.id);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("rehypeHeadingIds", () => {
  it("slugs heading text the way GitHub does, numbering repeats in document order", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        heading("h1", text("Plan")),
        heading("h2", text("Risks")),
        {
          type: "element",
          tagName: "section",
          properties: {},
          children: [heading("h3", text("Risks"))],
        },
        heading("h2", text("What's new? (v2.0)")),
        heading("h2", text("Use "), heading("code", text("activateMarkdownLink")), text(" here")),
        heading("h6", text("Risks")),
      ],
    };

    expect(ids(tree)).toEqual([
      "user-content-plan",
      "user-content-risks",
      "user-content-risks-1",
      "user-content-whats-new-v20",
      "user-content-use-activatemarkdownlink-here",
      "user-content-risks-2",
    ]);
  });

  it("leaves a heading that already has an id alone", () => {
    const label = heading("h2", text("Footnotes"));
    label.properties.id = "footnote-label";
    const tree: HastRoot = { type: "root", children: [label, heading("h2", text("Footnotes"))] };

    expect(ids(tree)).toEqual(["footnote-label", "user-content-footnotes"]);
  });

  it("starts the numbering again for every document", () => {
    const transform = rehypeHeadingIds();
    const first: HastRoot = { type: "root", children: [heading("h2", text("Risks"))] };
    const second: HastRoot = { type: "root", children: [heading("h2", text("Risks"))] };
    transform(first);
    transform(second);

    expect((second.children[0] as HastElement).properties.id).toBe("user-content-risks");
  });
});

describe("markdownFragmentIds", () => {
  it("prefixes a heading link", () => {
    expect(markdownFragmentIds("#risks")).toEqual(["user-content-risks"]);
  });

  it("tries a prefixed fragment with the prefix again first, then as written", () => {
    expect(markdownFragmentIds("#user-content-fn-1")).toEqual([
      "user-content-user-content-fn-1",
      "user-content-fn-1",
    ]);
  });

  it("keeps the fragment's case", () => {
    expect(markdownFragmentIds("#Risks")).toEqual(["user-content-Risks"]);
  });

  it("tries the decoded fragment before the encoded one", () => {
    expect(markdownFragmentIds("#caf%C3%A9-notes")).toEqual([
      `${MARKDOWN_ID_PREFIX}café-notes`,
      `${MARKDOWN_ID_PREFIX}caf%C3%A9-notes`,
    ]);
    expect(markdownFragmentIds("#user-content-fn-%C3%A9")).toEqual([
      "user-content-user-content-fn-é",
      "user-content-fn-é",
      "user-content-user-content-fn-%C3%A9",
      "user-content-fn-%C3%A9",
    ]);
  });

  it("keeps a fragment that won't decode as written", () => {
    expect(markdownFragmentIds("#100%")).toEqual(["user-content-100%"]);
  });

  it("names nothing for a bare hash or a non-fragment href", () => {
    expect(markdownFragmentIds("#")).toEqual([]);
    expect(markdownFragmentIds("./guide.md#usage")).toEqual([]);
    expect(markdownFragmentIds("https://example.com/#x")).toEqual([]);
  });
});

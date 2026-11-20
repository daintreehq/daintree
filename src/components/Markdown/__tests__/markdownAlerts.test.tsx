// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Element as HastElement, ElementContent, Root } from "hast";
import { MarkdownDocument } from "../MarkdownDocument";
import { rehypeMarkdownAlerts } from "../markdownAlerts";

afterEach(cleanup);

function renderDocument(content: string): HTMLElement {
  const { container } = render(
    <MarkdownDocument content={content} filePath="/repo/notes.md" rootPath="/repo" />
  );
  return container;
}

/** Text as read, with the line endings hast lays block markup out with collapsed. */
function words(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function alerts(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".markdown-alert")];
}

describe("GitHub alerts in rendered Markdown (#17333)", () => {
  it("renders each of GitHub's five markers as a titled box without the marker", () => {
    const content = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
      .map((marker) => `> [!${marker}]\n> Body for ${marker.toLowerCase()}.`)
      .join("\n\n");

    const container = renderDocument(content);
    const boxes = alerts(container);

    expect(boxes.map((box) => box.getAttribute("data-markdown-alert"))).toEqual([
      "note",
      "tip",
      "important",
      "warning",
      "caution",
    ]);
    expect(boxes.map((box) => box.querySelector(".markdown-alert-title")?.textContent)).toEqual([
      "Note",
      "Tip",
      "Important",
      "Warning",
      "Caution",
    ]);
    expect(boxes.map((box) => box.className)).toEqual(
      ["note", "tip", "important", "warning", "caution"].map(
        (type) => `markdown-alert markdown-alert-${type}`
      )
    );
    expect(words(boxes[3])).toBe("Warning Body for warning.");
    expect(container.textContent).not.toContain("[!");
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("draws a glyph of each type's own beside its title, hidden from assistive technology", () => {
    const container = renderDocument(
      ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
        .map((marker) => `> [!${marker}]\n> Body.`)
        .join("\n\n")
    );
    const glyphs = alerts(container).map((box) => box.querySelector(".markdown-alert-title svg"));

    expect(glyphs.map((glyph) => glyph?.getAttribute("aria-hidden"))).toEqual(
      Array(5).fill("true")
    );
    expect(new Set(glyphs.map((glyph) => glyph?.innerHTML)).size).toBe(5);
  });

  it("keeps the alert's own Markdown: paragraphs, lists and inline formatting", () => {
    const container = renderDocument(
      "> [!WARNING]\n> This **drops** the table.\n>\n> - back it up\n> - then migrate"
    );
    const box = alerts(container)[0];
    expect(box?.querySelector("strong")?.textContent).toBe("drops");
    expect(box?.querySelectorAll("li")).toHaveLength(2);
    expect(box?.querySelector("p:not(.markdown-alert-title)")?.textContent).toBe(
      "This drops the table."
    );
  });

  it("matches the type name in any case, as GitHub does", () => {
    const container = renderDocument("> [!note]\n> Lower case.\n\n> [!Warning]\n> Mixed case.");
    expect(alerts(container).map((box) => box.getAttribute("data-markdown-alert"))).toEqual([
      "note",
      "warning",
    ]);
  });

  it("takes a marker on a line of its own, its body in the following paragraph", () => {
    const container = renderDocument("> [!IMPORTANT]\n>\n> Read this first.");
    const box = alerts(container)[0];
    expect(box?.getAttribute("data-markdown-alert")).toBe("important");
    expect(words(box)).toBe("Important Read this first.");
    expect(box?.querySelectorAll("p")).toHaveLength(2);
  });

  it("takes a marker ended by a hard line break", () => {
    const container = renderDocument("> [!NOTE]  \n> After a hard break.");
    const box = alerts(container)[0];
    expect(box?.getAttribute("data-markdown-alert")).toBe("note");
    expect(box?.querySelector("br")).toBeNull();
    expect(box?.querySelector("p:not(.markdown-alert-title)")?.textContent).toBe(
      "After a hard break."
    );
  });

  it("leaves an unknown marker as a literal blockquote", () => {
    const container = renderDocument("> [!FOO]\n> Not a type GitHub knows.");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent).toContain("[!FOO]");
  });

  it("leaves a marker with text after it on the same line as a blockquote", () => {
    const container = renderDocument("> [!NOTE] Inline title\n> Body.");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent).toContain("[!NOTE] Inline title");
  });

  it("leaves a marker that is the whole blockquote as written", () => {
    const container = renderDocument("> [!WARNING]");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent).toContain("[!WARNING]");
  });

  it("leaves a marker that is not the start of the blockquote alone", () => {
    const container = renderDocument("> Intro line.\n> [!NOTE]\n> Body.");
    expect(alerts(container)).toHaveLength(0);
  });

  it("leaves a formatted marker alone", () => {
    const container = renderDocument("> **[!NOTE]**\n> Body.");
    expect(alerts(container)).toHaveLength(0);
  });

  it("only recognises an alert at the top of the document, as GitHub does", () => {
    const container = renderDocument(
      "- item\n\n  > [!NOTE]\n  > In a list.\n\n> > [!TIP]\n> > In a quote."
    );
    expect(alerts(container)).toHaveLength(0);
    expect(container.textContent).toContain("[!NOTE]");
    expect(container.textContent).toContain("[!TIP]");
  });

  it("takes a marker ended by a CRLF line ending", () => {
    const container = renderDocument("> [!TIP]\r\n> Windows line endings.\r\n");
    const box = alerts(container)[0];
    expect(box?.getAttribute("data-markdown-alert")).toBe("tip");
    expect(words(box)).toBe("Tip Windows line endings.");
  });

  it("takes a marker ended by a bare carriage return", () => {
    const container = renderDocument("> [!TIP]\r> Old Mac line endings.");
    const box = alerts(container)[0];
    expect(box?.getAttribute("data-markdown-alert")).toBe("tip");
    expect(words(box)).toBe("Tip Old Mac line endings.");
  });

  it("finds the body past raw HTML that never renders", () => {
    const container = renderDocument("> [!NOTE]\n>\n> <!-- aside -->\n>\n> Read this.");
    const box = alerts(container)[0];
    expect(box?.getAttribute("data-markdown-alert")).toBe("note");
    expect(words(box)).toBe("Note Read this.");
  });

  it("leaves a marker followed on its line by a space it can't have", () => {
    const container = renderDocument("> [!NOTE]&#32;\n>\n> Body.");
    expect(alerts(container)).toHaveLength(0);
  });

  it("keeps a body that is only an image", () => {
    const container = renderDocument("> [!NOTE]\n> ![diagram](https://example.com/d.png)");
    const box = alerts(container)[0];
    expect(box?.querySelector("img")?.getAttribute("alt")).toBe("diagram");
  });

  it("lets raw HTML on the marker's line end it, as any other markup does", () => {
    const container = renderDocument("> [!NOTE]<!-- aside -->\n> Body.");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent).toContain("[!NOTE]");
  });

  it("gives a marker no body made only of raw HTML, which never renders", () => {
    const container = renderDocument("> [!NOTE]\n>\n> <div>dropped</div>");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent).toContain("[!NOTE]");
  });

  it("leaves an ordinary blockquote as a blockquote", () => {
    const container = renderDocument("> Just a quote.");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent?.trim()).toBe("Just a quote.");
  });
});

describe("rehypeMarkdownAlerts through the rendered diff's revision marks", () => {
  const text = (value: string): ElementContent => ({ type: "text", value });
  const element = (
    tagName: string,
    children: ElementContent[],
    className?: string[]
  ): HastElement => ({
    type: "element",
    tagName,
    properties: className ? { className } : {},
    children,
  });
  /** Shaped as `inlineRangePlugin` builds one: a hidden label, then the changed text. */
  const mark = (tagName: "ins" | "del", value: string) =>
    element(
      tagName,
      [element("span", [text("Inserted: ")], ["sr-only"]), text(value)],
      ["revision"]
    );
  const isRevisionMark = (node: HastElement) =>
    Array.isArray(node.properties.className) && node.properties.className.includes("revision");

  function quote(paragraph: ElementContent[]): { tree: Root; blockquote: HastElement } {
    const blockquote = element("blockquote", [text("\n"), element("p", paragraph), text("\n")]);
    return { tree: { type: "root", children: [blockquote] }, blockquote };
  }

  function paragraphOf(blockquote: HastElement): HastElement | undefined {
    return blockquote.children.find(
      (child): child is HastElement => child.type === "element" && child.tagName === "p"
    );
  }

  it("reads a marker split across a mark, and takes the emptied mark out with it", () => {
    const { tree, blockquote } = quote([
      text("[!"),
      mark("ins", "WARNING"),
      text("]\nDrop the "),
      mark("ins", "new"),
      text(" table."),
    ]);

    rehypeMarkdownAlerts({ isRevisionMark })(tree);

    expect(blockquote.properties.dataMarkdownAlert).toBe("warning");
    const children = paragraphOf(blockquote)?.children ?? [];
    expect(
      children.map((child) => (child.type === "element" ? child.tagName : child.type))
    ).toEqual(["text", "ins", "text"]);
    expect(children[0]).toEqual(text("Drop the "));
  });

  it("keeps a mark that runs on into the body, with its label and its body text", () => {
    const changed = mark("ins", "]\nNew");
    const { tree, blockquote } = quote([text("[!NOTE"), changed, text(" body.")]);

    rehypeMarkdownAlerts({ isRevisionMark })(tree);

    expect(blockquote.properties.dataMarkdownAlert).toBe("note");
    expect(paragraphOf(blockquote)?.children).toEqual([changed, text(" body.")]);
    expect(changed.children).toEqual([
      element("span", [text("Inserted: ")], ["sr-only"]),
      text("New"),
    ]);
  });

  it("takes the line ending written after a hard break, even past an emptied mark", () => {
    const { tree, blockquote } = quote([
      text("[!"),
      mark("ins", "WARNING"),
      text("]"),
      element("br", []),
      text("\n"),
      text("Body."),
    ]);

    rehypeMarkdownAlerts({ isRevisionMark })(tree);

    expect(blockquote.properties.dataMarkdownAlert).toBe("warning");
    expect(paragraphOf(blockquote)?.children).toEqual([text("Body.")]);
  });

  it("keeps a line ending the body opens with when no hard break ended the marker", () => {
    const { tree, blockquote } = quote([text("[!NOTE]\n\nBody.")]);

    rehypeMarkdownAlerts()(tree);

    expect(blockquote.properties.dataMarkdownAlert).toBe("note");
    expect(paragraphOf(blockquote)?.children).toEqual([text("\nBody.")]);
  });

  it("keeps a body that is only a no-break space", () => {
    const { tree, blockquote } = quote([text("[!NOTE]\n\u00a0")]);

    rehypeMarkdownAlerts()(tree);

    expect(blockquote.properties.dataMarkdownAlert).toBe("note");
    expect(paragraphOf(blockquote)?.children).toEqual([text("\u00a0")]);
  });

  it("treats the same mark as ordinary markup when it isn't named a revision mark", () => {
    const { tree, blockquote } = quote([text("[!"), mark("ins", "WARNING"), text("]\nBody.")]);

    rehypeMarkdownAlerts()(tree);

    expect(blockquote.properties.dataMarkdownAlert).toBeUndefined();
    expect(paragraphOf(blockquote)?.children).toHaveLength(3);
  });
});

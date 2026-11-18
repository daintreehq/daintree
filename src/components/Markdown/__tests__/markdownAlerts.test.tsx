// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MarkdownDocument } from "../MarkdownDocument";

afterEach(cleanup);

function renderDocument(content: string): HTMLElement {
  const { container } = render(
    <MarkdownDocument content={content} filePath="/repo/notes.md" rootPath="/repo" />
  );
  return container;
}

/** Text as read, with the line endings hast lays block markup out with collapsed. */
function words(element: Element | undefined): string {
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
    expect(words(boxes[3])).toBe("Warning Body for warning.");
    expect(container.textContent).not.toContain("[!");
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("draws the type's glyph beside the title, hidden from assistive technology", () => {
    const container = renderDocument("> [!TIP]\n> Try this.");
    const glyph = container.querySelector(".markdown-alert-title svg");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
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
  });

  it("takes a marker ended by a hard line break", () => {
    const container = renderDocument("> [!NOTE]  \n> After a hard break.");
    const box = alerts(container)[0];
    expect(box?.getAttribute("data-markdown-alert")).toBe("note");
    expect(box?.querySelector("br")).toBeNull();
    expect(words(box)).toBe("Note After a hard break.");
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

  it("leaves an ordinary blockquote as a blockquote", () => {
    const container = renderDocument("> Just a quote.");
    expect(alerts(container)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent?.trim()).toBe("Just a quote.");
  });
});

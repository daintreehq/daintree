import { describe, expect, it } from "vitest";
import { adfToText } from "../adf.js";

function doc(...content: unknown[]) {
  return { type: "doc", version: 1, content };
}

function para(...content: unknown[]) {
  return { type: "paragraph", content };
}

function text(value: string, marks?: unknown[]) {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

describe("adfToText", () => {
  it("reads an empty description as empty", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText(doc())).toBe("");
  });

  it("passes a plain string through", () => {
    expect(adfToText("already text")).toBe("already text");
  });

  it("separates paragraphs and keeps hard breaks", () => {
    expect(
      adfToText(doc(para(text("one"), { type: "hardBreak" }, text("two")), para(text("three"))))
    ).toBe("one\ntwo\n\nthree");
  });

  it("renders inline nodes from their attributes", () => {
    expect(
      adfToText(
        doc(
          para(
            { type: "mention", attrs: { id: "abc", text: "@Ada" } },
            text(" "),
            { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
            text(" "),
            { type: "emoji", attrs: { shortName: ":custom:" } },
            text(" "),
            { type: "status", attrs: { text: "BLOCKED", color: "red" } },
            text(" "),
            { type: "date", attrs: { timestamp: "1767225600000" } },
            text(" "),
            { type: "inlineCard", attrs: { url: "https://example.com/card" } }
          )
        )
      )
    ).toBe("@Ada 😄 :custom: BLOCKED 2026-01-01 https://example.com/card");
  });

  it("names a mention it can't resolve instead of dropping it", () => {
    expect(adfToText(doc(para({ type: "mention", attrs: { id: "abc" } })))).toBe("@unknown");
  });

  it("drops a date it can't read rather than throwing", () => {
    expect(adfToText(doc(para({ type: "date", attrs: { timestamp: "soon" } })))).toBe("");
    expect(adfToText(doc(para({ type: "date", attrs: {} })))).toBe("");
  });

  it("keeps a link's address and marks code", () => {
    expect(
      adfToText(
        doc(
          para(
            text("docs", [{ type: "link", attrs: { href: "https://example.com" } }]),
            text(" and "),
            text("https://example.com", [{ type: "link", attrs: { href: "https://example.com" } }]),
            text(" and "),
            text("npm test", [{ type: "code" }])
          )
        )
      )
    ).toBe("[docs](https://example.com) and https://example.com and `npm test`");
  });

  it("renders headings, rules, quotes and code blocks", () => {
    expect(
      adfToText(
        doc(
          { type: "heading", attrs: { level: 2 }, content: [text("Steps")] },
          { type: "rule" },
          { type: "blockquote", content: [para(text("quoted")), para(text("twice"))] },
          { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] }
        )
      )
    ).toBe("## Steps\n\n---\n\n> quoted\n> \n> twice\n\n```ts\nconst a = 1;\n```");
  });

  it("renders bullet and numbered lists, nesting included", () => {
    expect(
      adfToText(
        doc({
          type: "bulletList",
          content: [
            { type: "listItem", content: [para(text("one"))] },
            {
              type: "listItem",
              content: [
                para(text("two")),
                {
                  type: "orderedList",
                  attrs: { order: 3 },
                  content: [
                    { type: "listItem", content: [para(text("three"))] },
                    { type: "listItem", content: [para(text("four"))] },
                  ],
                },
              ],
            },
          ],
        })
      )
    ).toBe("- one\n- two\n  3. three\n  4. four");
  });

  it("renders tasks and decisions", () => {
    expect(
      adfToText(
        doc(
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { state: "TODO" }, content: [text("open")] },
              { type: "taskItem", attrs: { state: "DONE" }, content: [text("closed")] },
            ],
          },
          {
            type: "decisionList",
            content: [
              { type: "decisionItem", attrs: { state: "DECIDED" }, content: [text("ship it")] },
            ],
          }
        )
      )
    ).toBe("- [ ] open\n- [x] closed\n\n- ship it");
  });

  it("indents a task list nested directly in a task list", () => {
    expect(
      adfToText(
        doc({
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "TODO" }, content: [text("parent")] },
            {
              type: "taskList",
              content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("child")] }],
            },
          ],
        })
      )
    ).toBe("- [ ] parent\n  - [x] child");
  });

  it("renders tables a row to a line", () => {
    expect(
      adfToText(
        doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [para(text("Name"))] },
                { type: "tableHeader", content: [para(text("Value"))] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [para(text("a")), para(text("b"))] },
                { type: "tableCell", content: [para(text("c"))] },
              ],
            },
          ],
        })
      )
    ).toBe("Name | Value\na b | c");
  });

  it("opens panels and expands, and says where an attachment was", () => {
    expect(
      adfToText(
        doc(
          { type: "panel", attrs: { panelType: "info" }, content: [para(text("note"))] },
          { type: "expand", attrs: { title: "More" }, content: [para(text("hidden"))] },
          {
            type: "mediaSingle",
            content: [{ type: "media", attrs: { id: "1", alt: "shot.png" } }],
          },
          { type: "mediaGroup", content: [{ type: "media", attrs: { id: "2" } }] }
        )
      )
    ).toBe("note\n\nMore\n\nhidden\n\n[attachment: shot.png]\n\n[attachment]");
  });

  it("keeps the text of a node type it doesn't know", () => {
    expect(
      adfToText(
        doc(
          { type: "futureBlock", content: [para(text("inside"))] },
          { type: "futureLeaf", attrs: { text: "from attrs" } },
          { type: "futureText", text: "from text" }
        )
      )
    ).toBe("inside\n\nfrom attrs\n\nfrom text");
  });

  it("survives malformed nodes", () => {
    expect(adfToText(42)).toBe("");
    expect(adfToText(doc("nope", null, para(null, text("ok"), { type: "text" })))).toBe("ok");
    expect(adfToText({ type: "doc", content: "nope" })).toBe("");
  });

  it("stops at a depth no document reaches rather than overflowing the stack", () => {
    let node: unknown = text("too deep");
    for (let i = 0; i < 100_000; i++) node = { type: "panel", content: [node] };
    expect(adfToText(node)).toBe("");
  });
});

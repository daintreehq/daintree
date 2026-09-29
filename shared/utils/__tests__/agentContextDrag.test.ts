import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_DRAG_MIME,
  AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH,
  AGENT_CONTEXT_MAX_TEXT_LENGTH,
  AGENT_CONTEXT_MAX_TITLE_LENGTH,
  appendAgentContextToDraft,
  decodeAgentContextDragPayload,
  encodeAgentContextDragPayload,
  agentContextBlockRanges,
  closingFenceForOpenBlock,
  formatAgentContextBlock,
  sanitizeAgentContextSourceLabel,
  setAgentContextDragData,
  validateAgentContextPayload,
} from "../agentContextDrag.js";

describe("validateAgentContextPayload", () => {
  it("accepts the minimal payload and keeps optional fields only when present", () => {
    expect(validateAgentContextPayload({ v: 1, text: "Fix the login redirect" })).toEqual({
      v: 1,
      text: "Fix the login redirect",
    });
    expect(
      validateAgentContextPayload({
        v: 1,
        text: "body",
        title: "Card",
        source: { label: "Kanban" },
      })
    ).toEqual({ v: 1, text: "body", title: "Card", source: { label: "Kanban" } });
  });

  it.each([
    ["a non-object", "text"],
    ["null", null],
    ["an array", [{ v: 1, text: "x" }]],
    ["a wrong version", { v: 2, text: "x" }],
    ["a missing version", { text: "x" }],
    ["missing text", { v: 1 }],
    ["non-string text", { v: 1, text: 42 }],
    ["blank text", { v: 1, text: " \n\t " }],
    ["a non-string title", { v: 1, text: "x", title: 1 }],
    ["a non-object source", { v: 1, text: "x", source: "Kanban" }],
    ["a non-string source label", { v: 1, text: "x", source: { label: 3 } }],
  ])("rejects %s", (_name, value) => {
    expect(validateAgentContextPayload(value)).toBeNull();
  });

  it("enforces the size limits at their exact boundaries", () => {
    const text = "a".repeat(AGENT_CONTEXT_MAX_TEXT_LENGTH);
    expect(validateAgentContextPayload({ v: 1, text })?.text).toHaveLength(
      AGENT_CONTEXT_MAX_TEXT_LENGTH
    );
    expect(validateAgentContextPayload({ v: 1, text: `${text}a` })).toBeNull();

    const title = "t".repeat(AGENT_CONTEXT_MAX_TITLE_LENGTH);
    expect(validateAgentContextPayload({ v: 1, text: "x", title })?.title).toBe(title);
    expect(validateAgentContextPayload({ v: 1, text: "x", title: `${title}t` })).toBeNull();

    const label = "l".repeat(AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH);
    expect(validateAgentContextPayload({ v: 1, text: "x", source: { label } })?.source).toEqual({
      label,
    });
    expect(
      validateAgentContextPayload({ v: 1, text: "x", source: { label: `${label}l` } })
    ).toBeNull();
  });

  it("drops control characters from text but keeps tabs and newlines, normalising CRLF", () => {
    const result = validateAgentContextPayload({
      v: 1,
      text: "one\r\ntwo\rthree\tfour\u001b[31mred\u0003\u009b",
    });
    expect(result?.text).toBe("one\ntwo\nthree\tfour[31mred");
  });

  it("collapses a title and label to one trimmed line, and treats empty as absent", () => {
    const result = validateAgentContextPayload({
      v: 1,
      text: "x",
      title: "  Fix\nthe\u0007 bug  ",
      source: { label: "   " },
    });
    expect(result).toEqual({ v: 1, text: "x", title: "Fix the bug" });
  });
});

describe("encode / decode", () => {
  it("round-trips a payload", () => {
    const payload = { v: 1 as const, text: "body", title: "Card", source: { label: "CRM" } };
    expect(decodeAgentContextDragPayload(encodeAgentContextDragPayload(payload))).toEqual(payload);
  });

  it("throws at encode time for a payload the drop would refuse", () => {
    expect(() => encodeAgentContextDragPayload({ v: 1, text: "   " })).toThrow(TypeError);
  });

  it("decodes garbage, empty strings and oversized input to null", () => {
    expect(decodeAgentContextDragPayload("")).toBeNull();
    expect(decodeAgentContextDragPayload("{not json")).toBeNull();
    expect(decodeAgentContextDragPayload(JSON.stringify({ v: 1 }))).toBeNull();
    const huge = JSON.stringify({ v: 1, text: "x", pad: "p".repeat(400_000) });
    expect(decodeAgentContextDragPayload(huge)).toBeNull();
  });
});

describe("setAgentContextDragData", () => {
  it("writes the agent-context type, a text/plain fallback and a copy effect", () => {
    const setData = vi.fn();
    const transfer = { setData, effectAllowed: "all" };
    setAgentContextDragData(transfer, { v: 1, text: "body", title: "Card" });
    expect(setData).toHaveBeenCalledWith(
      AGENT_CONTEXT_DRAG_MIME,
      JSON.stringify({ v: 1, text: "body", title: "Card" })
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "body");
    expect(transfer.effectAllowed).toBe("copy");
  });

  it("writes nothing for an invalid payload", () => {
    const setData = vi.fn();
    expect(() =>
      setAgentContextDragData({ setData, effectAllowed: "all" }, { v: 1, text: "" })
    ).toThrow(TypeError);
    expect(setData).not.toHaveBeenCalled();
  });
});

describe("formatAgentContextBlock", () => {
  it("puts the heading and the text inside one tagged fence", () => {
    expect(
      formatAgentContextBlock({
        text: "line one\nline two\n\n",
        title: "Card",
        sourceLabel: "Kanban",
      })
    ).toBe("```daintree-context\nKanban: Card\n\nline one\nline two\n```");
  });

  it("omits the heading when there is nothing to put in it", () => {
    expect(formatAgentContextBlock({ text: "body" })).toBe("```daintree-context\nbody\n```");
  });

  it("fences with more backticks than the longest run in the text or heading", () => {
    const block = formatAgentContextBlock({ text: "before\n````\ninner\n````\nafter" });
    expect(block.startsWith("`````daintree-context\n")).toBe(true);
    expect(block.endsWith("\n`````")).toBe(true);
    const titled = formatAgentContextBlock({ text: "x", title: "``````" });
    expect(titled.startsWith("```````daintree-context\n")).toBe(true);
  });

  it("sanitises every part, the host-supplied label included", () => {
    const block = formatAgentContextBlock({
      text: "safe\u001b]0;pwned\u0007 text\r\nnext",
      title: "Title\rwith\u009bcontrols",
      sourceLabel: `Acme\u001b[31m\n${"x".repeat(200)}`,
    });
    for (let i = 0; i < block.length; i++) {
      const code = block.charCodeAt(i);
      const allowed = code === 0x0a || code === 0x09;
      expect(allowed || (code > 0x1f && (code < 0x7f || code > 0x9f))).toBe(true);
    }
    const heading = block.split("\n")[1]!;
    expect(heading.startsWith("Acme [31m x")).toBe(true);
    expect(heading).toContain(": Title with controls");
    expect(heading.split(": ")[0]!.length).toBeLessThanOrEqual(
      AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH
    );
  });
});

describe("sanitizeAgentContextSourceLabel", () => {
  it("bounds a display name to one line of the label limit", () => {
    expect(sanitizeAgentContextSourceLabel("  Acme\nBoard\u001b ")).toBe("Acme Board");
    const long = sanitizeAgentContextSourceLabel("n".repeat(500));
    expect(long.length).toBe(AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("appendAgentContextToDraft", () => {
  it("fills an empty draft and ends on a fresh line", () => {
    expect(appendAgentContextToDraft("", "BLOCK")).toBe("BLOCK\n");
  });

  it.each([
    ["text with no newline", "look at this", "look at this\n\nBLOCK\n"],
    ["trailing spaces", "look at this   ", "look at this   \n\nBLOCK\n"],
    ["one trailing newline", "look at this\n", "look at this\n\nBLOCK\n"],
    ["a trailing blank line", "look at this\n\n", "look at this\n\nBLOCK\n"],
    ["several blank lines", "look at this\n\n\n\n", "look at this\n\n\n\nBLOCK\n"],
    ["whitespace only", "  \n", "  \n\nBLOCK\n"],
    ["a closed fence", "see\n```\ncode\n```", "see\n```\ncode\n```\n\nBLOCK\n"],
  ])("keeps a draft with %s exactly as typed", (_name, draft, expected) => {
    const result = appendAgentContextToDraft(draft, "BLOCK");
    expect(result).toBe(expected);
    expect(result.startsWith(draft)).toBe(true);
  });

  it.each([
    ["mid-line", "see\n````js\nconst a = 1;", "see\n````js\nconst a = 1;\n````\n\nBLOCK\n"],
    ["after a newline", "~~~\nnotes\n", "~~~\nnotes\n~~~\n\nBLOCK\n"],
  ])("closes a fence the draft leaves open %s before appending", (_name, draft, expected) => {
    const result = appendAgentContextToDraft(draft, "BLOCK");
    expect(result).toBe(expected);
    expect(result.startsWith(draft)).toBe(true);
  });
});

describe("closingFenceForOpenBlock", () => {
  it.each<[string, string, string | null]>([
    ["no fences", "plain text", null],
    ["a closed fence", "```\ncode\n```", null],
    ["an open backtick fence", "```ts\ncode", "```"],
    ["an open fence a shorter run cannot close", "````\n```\ncode", "````"],
    ["an open tilde fence a backtick run cannot close", "~~~\n```\ncode", "~~~"],
    ["a line whose info string holds a backtick", "``` a`b\ntext", null],
  ])("reports %s", (_name, text, expected) => {
    expect(closingFenceForOpenBlock(text)).toBe(expected);
  });
});

describe("agentContextBlockRanges", () => {
  it("finds a handoff block, including its fence lines", () => {
    const block = formatAgentContextBlock({ text: "@diff" });
    const text = `before\n${block}\nafter`;
    expect(agentContextBlockRanges(text)).toEqual([[7, 7 + block.length]]);
  });

  it("ignores fences the user wrote, whatever their info string", () => {
    expect(agentContextBlockRanges("```\n@diff\n```\n```ts\n@diff\n```")).toEqual([]);
  });

  it("keeps its edges when an unclosed user fence sits above it", () => {
    const block = formatAgentContextBlock({ text: "@diff" });
    const text = `\`\`\`\nopen fence\n${block}\n@terminal`;
    const start = text.indexOf("```daintree-context");
    expect(agentContextBlockRanges(text)).toEqual([[start, start + block.length]]);
  });

  it("runs a block whose closing line was deleted to the end", () => {
    const text = "x\n```daintree-context\nbody @diff";
    expect(agentContextBlockRanges(text)).toEqual([[2, text.length]]);
  });
});

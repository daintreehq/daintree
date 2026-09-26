import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_DRAG_MIME,
  AGENT_CONTEXT_MAX_SOURCE_LABEL_LENGTH,
  AGENT_CONTEXT_MAX_TEXT_LENGTH,
  AGENT_CONTEXT_MAX_TITLE_LENGTH,
  appendAgentContextToDraft,
  decodeAgentContextDragPayload,
  encodeAgentContextDragPayload,
  formatAgentContextBlock,
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
  it("heads the fenced text with label and title", () => {
    expect(
      formatAgentContextBlock({
        text: "line one\nline two\n\n",
        title: "Card",
        sourceLabel: "Kanban",
      })
    ).toBe("Kanban: Card\n```\nline one\nline two\n```");
  });

  it("omits the heading when there is nothing to put in it", () => {
    expect(formatAgentContextBlock({ text: "body" })).toBe("```\nbody\n```");
  });

  it("fences with more backticks than the longest run in the text", () => {
    const block = formatAgentContextBlock({ text: "before\n````\ninner\n````\nafter" });
    expect(block.startsWith("`````\n")).toBe(true);
    expect(block.endsWith("\n`````")).toBe(true);
  });
});

describe("appendAgentContextToDraft", () => {
  it("fills an empty draft and ends on a fresh line", () => {
    expect(appendAgentContextToDraft("", "BLOCK")).toBe("BLOCK\n");
    expect(appendAgentContextToDraft("  \n", "BLOCK")).toBe("BLOCK\n");
  });

  it("keeps what the user typed and separates the block with a blank line", () => {
    expect(appendAgentContextToDraft("please look at this\n\n", "BLOCK")).toBe(
      "please look at this\n\nBLOCK\n"
    );
  });
});

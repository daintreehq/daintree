import { describe, it, expect } from "vitest";
import { getNoteDisplayTitle } from "../noteTitleDisplay";

describe("getNoteDisplayTitle", () => {
  it("returns stored title when present", () => {
    expect(getNoteDisplayTitle({ title: "My Note", preview: "first line" })).toBe("My Note");
  });

  it("falls back to preview when title is empty", () => {
    expect(getNoteDisplayTitle({ title: "", preview: "first line of content" })).toBe(
      "first line of content"
    );
  });

  it("falls back to preview when title is whitespace", () => {
    expect(getNoteDisplayTitle({ title: "  ", preview: "content" })).toBe("content");
  });

  it('returns "Untitled" when both title and preview are empty', () => {
    expect(getNoteDisplayTitle({ title: "", preview: "" })).toBe("Untitled");
  });

  it('returns "Untitled" when both are whitespace', () => {
    expect(getNoteDisplayTitle({ title: "  ", preview: "  " })).toBe("Untitled");
  });
});

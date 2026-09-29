import { describe, it, expect } from "vitest";
import {
  SCRATCHPAD_DEFAULT_WIDTH,
  SCRATCHPAD_MAX_CHARS,
  SCRATCHPAD_MAX_WIDTH,
  SCRATCHPAD_MIN_WIDTH,
  clampScratchpadWidth,
  sanitizeScratchpad,
  scratchpadHasContent,
} from "../terminalScratchpad";

describe("sanitizeScratchpad", () => {
  it("keeps a well-formed record, content exactly as typed", () => {
    const content = "  ## Next\n\n- `npm test`\n";
    expect(sanitizeScratchpad({ content, collapsed: false, width: 300 })).toEqual({
      content,
      collapsed: false,
      width: 300,
    });
  });

  it.each([undefined, null, "notes", 42, { collapsed: true }, { content: 7, collapsed: false }])(
    "drops a malformed value (%j)",
    (value) => {
      expect(sanitizeScratchpad(value)).toBeUndefined();
    }
  );

  it("treats anything but a literal true as expanded", () => {
    expect(sanitizeScratchpad({ content: "x", collapsed: "yes" })?.collapsed).toBe(false);
  });

  it("drops a collapsed record with nothing in it, since nothing could expand it", () => {
    expect(sanitizeScratchpad({ content: "  \n", collapsed: true })).toBeUndefined();
    expect(sanitizeScratchpad({ content: "  \n", collapsed: false })).toEqual({
      content: "  \n",
      collapsed: false,
    });
  });

  it("clamps a finite width and drops a non-finite one", () => {
    expect(sanitizeScratchpad({ content: "x", collapsed: false, width: 5 })?.width).toBe(
      SCRATCHPAD_MIN_WIDTH
    );
    expect(sanitizeScratchpad({ content: "x", collapsed: false, width: 99_999 })?.width).toBe(
      SCRATCHPAD_MAX_WIDTH
    );
    const noWidth = sanitizeScratchpad({ content: "x", collapsed: false, width: Number.NaN });
    expect(noWidth && "width" in noWidth).toBe(false);
  });

  it("bounds oversized content", () => {
    const result = sanitizeScratchpad({
      content: "a".repeat(SCRATCHPAD_MAX_CHARS + 50),
      collapsed: false,
    });
    expect(result?.content.length).toBe(SCRATCHPAD_MAX_CHARS);
  });
});

describe("clampScratchpadWidth", () => {
  it("folds non-finite input back to the default", () => {
    expect(clampScratchpadWidth(Number.POSITIVE_INFINITY)).toBe(SCRATCHPAD_DEFAULT_WIDTH);
    expect(clampScratchpadWidth(Number.NaN)).toBe(SCRATCHPAD_DEFAULT_WIDTH);
  });
});

describe("scratchpadHasContent", () => {
  it("ignores whitespace", () => {
    expect(scratchpadHasContent(undefined)).toBe(false);
    expect(scratchpadHasContent({ content: " \n\t", collapsed: false })).toBe(false);
    expect(scratchpadHasContent({ content: " x ", collapsed: false })).toBe(true);
  });
});

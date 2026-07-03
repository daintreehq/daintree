import { describe, it, expect } from "vitest";
import { cleanTaskTitle } from "../taskTitle.js";

describe("cleanTaskTitle", () => {
  it("strips Claude's leading spinner glyph", () => {
    expect(cleanTaskTitle("✳ Explore possible solution approach")).toBe(
      "Explore possible solution approach"
    );
  });

  it("strips each glyph of Claude's spinner set", () => {
    for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽", "●", "✼", "✾", "⟡", "◇", "◆", "○"]) {
      expect(cleanTaskTitle(`${glyph} fix auth bug`)).toBe("fix auth bug");
    }
  });

  it("strips Gemini's state glyphs (they encode agent state, not task text)", () => {
    expect(cleanTaskTitle("✦ writing tests")).toBe("writing tests");
    expect(cleanTaskTitle("✋ waiting for approval")).toBe("waiting for approval");
  });

  it("strips stacked glyph clusters", () => {
    expect(cleanTaskTitle("✳ ✻ task")).toBe("task");
  });

  it("leaves interior glyphs alone", () => {
    expect(cleanTaskTitle("deploy ✳ prod")).toBe("deploy ✳ prod");
  });

  it("does not strip leading words, parens, or colons", () => {
    expect(cleanTaskTitle("(re)do the thing")).toBe("(re)do the thing");
    expect(cleanTaskTitle("fix: auth bug")).toBe("fix: auth bug");
  });

  it("returns empty string for null/undefined/whitespace/glyph-only input", () => {
    expect(cleanTaskTitle(null)).toBe("");
    expect(cleanTaskTitle(undefined)).toBe("");
    expect(cleanTaskTitle("   ")).toBe("");
    expect(cleanTaskTitle("✳ ")).toBe("");
  });
});

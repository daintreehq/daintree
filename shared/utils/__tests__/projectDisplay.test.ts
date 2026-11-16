import { describe, expect, it } from "vitest";
import { normalizeProjectDisplay } from "../projectDisplay.js";

describe("normalizeProjectDisplay", () => {
  it("keeps a plain name, emoji and colour, trimmed", () => {
    expect(normalizeProjectDisplay({ name: "  App ", emoji: " 🎸", color: " #fff " })).toEqual({
      name: "App",
      emoji: "🎸",
      color: "#fff",
    });
  });

  it("drops the whole identity when the name or emoji isn't usable", () => {
    for (const bad of [
      null,
      "App",
      [],
      { emoji: "🎸" },
      { name: "App" },
      { name: "  ", emoji: "🎸" },
      { name: "a\nb", emoji: "🎸" },
      { name: "x".repeat(101), emoji: "🎸" },
      { name: "App", emoji: "🎸".repeat(17) },
    ]) {
      expect(normalizeProjectDisplay(bad)).toBeNull();
    }
  });

  it("reads a missing or malformed colour as none, keeping the rest", () => {
    expect(normalizeProjectDisplay({ name: "App", emoji: "🎸" })).toEqual({
      name: "App",
      emoji: "🎸",
      color: null,
    });
    expect(normalizeProjectDisplay({ name: "App", emoji: "🎸", color: "x".repeat(257) })).toEqual({
      name: "App",
      emoji: "🎸",
      color: null,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  DISPLAY_NAME_MAX,
  assistantIdentityFor,
  displayIdentityLabel,
  normalizeDisplayEmoji,
  normalizeDisplayIdentity,
  normalizeDisplayName,
  withDisplayEmoji,
} from "../displayIdentity.js";

describe("normalizeDisplayName", () => {
  it("keeps a name on one line, without controls or bidi overrides", () => {
    expect(normalizeDisplayName("  Assistant to the\n Regional\u202e Manager ")).toBe(
      "Assistant to the Regional Manager"
    );
  });

  it("turns a control into a space and drops hidden formatting", () => {
    expect(normalizeDisplayName("Dw\u0007ight\u200b!")).toBe("Dw ight!");
  });

  it("unsets an empty or non-text name", () => {
    expect(normalizeDisplayName("   ")).toBeUndefined();
    expect(normalizeDisplayName(42)).toBeUndefined();
  });

  it("cuts a long name by grapheme, never through an emoji", () => {
    const name = "👩‍👩‍👧".repeat(DISPLAY_NAME_MAX + 5);
    const cut = normalizeDisplayName(name)!;
    expect(Array.from(new Intl.Segmenter().segment(cut))).toHaveLength(DISPLAY_NAME_MAX);
    expect(cut.endsWith("👩‍👩‍👧")).toBe(true);
  });
});

describe("normalizeDisplayEmoji", () => {
  it.each(["🐶", "👩‍💻", "🇳🇿", "1️⃣", "👍🏽", "❤️"])("keeps the single emoji %s", (emoji) => {
    expect(normalizeDisplayEmoji(` ${emoji} `)).toBe(emoji);
  });

  it.each(["A", "🐶🐱", "🐶 dog", "", "\u202e🐶", "\n🦊", "🦊\t"])("refuses %j", (value) => {
    expect(normalizeDisplayEmoji(value)).toBeUndefined();
  });
});

describe("normalizeDisplayIdentity", () => {
  it("drops unknown and invalid fields and keeps the valid ones", () => {
    expect(normalizeDisplayIdentity({ name: " Dot ", emoji: "dog", extra: 1 })).toEqual({
      name: "Dot",
    });
    expect(normalizeDisplayIdentity({ name: "Dot", emoji: "🐶" })).toEqual({
      name: "Dot",
      emoji: "🐶",
    });
    expect(normalizeDisplayIdentity(null)).toEqual({});
  });
});

describe("display labels", () => {
  it("falls back to the surface's own label and puts the emoji in front", () => {
    expect(displayIdentityLabel({}, "Global")).toBe("Global");
    expect(displayIdentityLabel({ emoji: "🐶" }, "Global")).toBe("🐶 Global");
    expect(displayIdentityLabel({ name: "Dot", emoji: "🐶" }, "Global")).toBe("🐶 Dot");
    expect(withDisplayEmoji("Claude", undefined)).toBe("Claude");
    expect(withDisplayEmoji("Claude", "🦊")).toBe("🦊 Claude");
  });

  it("resolves a scope's persona, empty for a project without one", () => {
    const identities = { global: { name: "G" }, projects: { p1: { name: "P" } } };
    expect(assistantIdentityFor(identities, { kind: "global" })).toEqual({ name: "G" });
    expect(assistantIdentityFor(identities, { kind: "project", projectId: "p1" })).toEqual({
      name: "P",
    });
    expect(assistantIdentityFor(identities, { kind: "project", projectId: "p2" })).toEqual({});
    // Only a project's own entry: never one Object.prototype lends it.
    expect(assistantIdentityFor(identities, { kind: "project", projectId: "constructor" })).toEqual(
      {}
    );
  });
});

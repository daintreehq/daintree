import { describe, it, expect } from "vitest";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "../projectEmoji.js";

describe("suggestProjectEmoji", () => {
  describe("unset input", () => {
    it("returns the default tree for a blank name", () => {
      expect(suggestProjectEmoji("")).toBe(DEFAULT_PROJECT_EMOJI);
      expect(suggestProjectEmoji("   ")).toBe(DEFAULT_PROJECT_EMOJI);
    });

    it("returns the default tree for a non-string input", () => {
      expect(suggestProjectEmoji(undefined as unknown as string)).toBe(DEFAULT_PROJECT_EMOJI);
      expect(suggestProjectEmoji(null as unknown as string)).toBe(DEFAULT_PROJECT_EMOJI);
    });
  });

  describe("keyword matching", () => {
    it("matches a whole token regardless of separator style", () => {
      const fromDash = suggestProjectEmoji("my-api-service");
      const fromUnderscore = suggestProjectEmoji("my_api_service");
      const fromSpace = suggestProjectEmoji("my api service");
      expect(fromDash).toBe(fromUnderscore);
      expect(fromDash).toBe(fromSpace);
    });

    it("splits camelCase into tokens", () => {
      expect(suggestProjectEmoji("myMobileApp")).toBe(suggestProjectEmoji("my-mobile-app"));
    });

    it("is case-insensitive", () => {
      expect(suggestProjectEmoji("DOCS")).toBe(suggestProjectEmoji("docs"));
    });

    it("does not match a keyword embedded inside a larger word", () => {
      // "rapid" contains "api" but is not the token "api".
      expect(suggestProjectEmoji("rapid")).not.toBe(suggestProjectEmoji("api"));
    });

    it("prefers the keyword appearing earliest in the name", () => {
      // Both `mobile` and `docs` are keywords; name order decides.
      expect(suggestProjectEmoji("mobile-docs")).toBe(suggestProjectEmoji("mobile"));
      expect(suggestProjectEmoji("docs-mobile")).toBe(suggestProjectEmoji("docs"));
    });

    it("gives different keywords different emoji", () => {
      const api = suggestProjectEmoji("api");
      const docs = suggestProjectEmoji("docs");
      const mobile = suggestProjectEmoji("mobile");
      expect(new Set([api, docs, mobile]).size).toBe(3);
    });
  });

  describe("hash fallback", () => {
    it("is deterministic for the same name", () => {
      const first = suggestProjectEmoji("zzquux-widget");
      const second = suggestProjectEmoji("zzquux-widget");
      expect(first).toBe(second);
    });

    it("normalizes separators and case before hashing", () => {
      expect(suggestProjectEmoji("My-Zzquux Widget")).toBe(suggestProjectEmoji("my zzquux widget"));
    });

    it("never falls back to the default tree", () => {
      // Any keyword-free name must produce a visibly distinct suggestion.
      const names = Array.from({ length: 60 }, (_, i) => `zzquux-${i}`);
      for (const name of names) {
        expect(suggestProjectEmoji(name)).not.toBe(DEFAULT_PROJECT_EMOJI);
      }
    });

    it("spreads keyword-free names across more than one emoji", () => {
      const names = Array.from({ length: 60 }, (_, i) => `zzquux-${i}`);
      const distinct = new Set(names.map(suggestProjectEmoji));
      expect(distinct.size).toBeGreaterThan(1);
    });

    it("returns a non-empty string for names with no alphanumeric tokens", () => {
      expect(suggestProjectEmoji("!!!")).toBeTruthy();
      expect(suggestProjectEmoji("...")).toBeTruthy();
    });
  });
});

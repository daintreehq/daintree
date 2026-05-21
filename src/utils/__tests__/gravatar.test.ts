/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { getGravatarUrl, isBotAuthor } from "../gravatar";

describe("getGravatarUrl", () => {
  it("returns a gravatar URL with the expected hash for a known email", () => {
    const url = getGravatarUrl("MyEmailAddress@example.com", 32);
    expect(url).toContain("https://www.gravatar.com/avatar/");
    expect(url).toContain("?s=32&d=404");
    // SHA-256 of "myemailaddress@example.com"
    const hash = url.split("/").pop()!.split("?")[0];
    expect(hash).toBe("84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee");
  });

  it("returns fallback hash for empty email", () => {
    const url = getGravatarUrl("", 16);
    expect(url).toContain("00000000000000000000000000000000");
    expect(url).toContain("?s=16&d=404");
  });

  it("trims whitespace and lowercases", () => {
    const url1 = getGravatarUrl("  Test@EXAMPLE.com  ", 40);
    const url2 = getGravatarUrl("test@example.com", 40);
    expect(url1).toBe(url2);
  });

  it("includes the size parameter", () => {
    const url = getGravatarUrl("a@b.com", 80);
    expect(url).toContain("?s=80&d=404");
  });
});

describe("isBotAuthor", () => {
  it("returns true for dependabot", () => {
    expect(isBotAuthor("dependabot[bot]")).toBe(true);
  });

  it("returns true for github-actions", () => {
    expect(isBotAuthor("github-actions[bot]")).toBe(true);
  });

  it("returns true for renovate", () => {
    expect(isBotAuthor("renovate[bot]")).toBe(true);
  });

  it("returns false for human authors", () => {
    expect(isBotAuthor("Jane Doe")).toBe(false);
    expect(isBotAuthor("john")).toBe(false);
    expect(isBotAuthor("")).toBe(false);
  });
});

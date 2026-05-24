import { describe, it, expect } from "vitest";
import { extractClosingIssueNumber } from "../closingIssueRef";

describe("extractClosingIssueNumber", () => {
  it("returns undefined for empty / nullish input", () => {
    expect(extractClosingIssueNumber(undefined)).toBeUndefined();
    expect(extractClosingIssueNumber(null)).toBeUndefined();
    expect(extractClosingIssueNumber("")).toBeUndefined();
  });

  it("returns undefined when no closing keyword is present", () => {
    expect(extractClosingIssueNumber("See #123 for context")).toBeUndefined();
    expect(extractClosingIssueNumber("Related to #123")).toBeUndefined();
  });

  it.each([
    ["Closes #123", 123],
    ["closes #7", 7],
    ["Closed #42", 42],
    ["Fixes #88", 88],
    ["fixed #5", 5],
    ["Fix #9", 9],
    ["Resolves #100", 100],
    ["resolved #11", 11],
  ])("parses %s → #%i", (body, expected) => {
    expect(extractClosingIssueNumber(body)).toBe(expected);
  });

  it("matches the keyword anywhere in a multi-line body", () => {
    const body = "## Summary\n\nDoes some things.\n\nFixes #456\n\nMore notes.";
    expect(extractClosingIssueNumber(body)).toBe(456);
  });

  it("parses cross-repo references (org/repo#N)", () => {
    expect(extractClosingIssueNumber("Closes daintreehq/daintree#321")).toBe(321);
    expect(extractClosingIssueNumber("Fixes some-org/some.repo-1#9")).toBe(9);
  });

  it("returns the first match when several closing refs exist", () => {
    expect(extractClosingIssueNumber("Closes #1, fixes #2, resolves #3")).toBe(1);
  });

  it("is case-insensitive on the keyword", () => {
    expect(extractClosingIssueNumber("CLOSES #77")).toBe(77);
  });

  it.each(["This hotfixes #123", "discloses #300", "prefix-fix #456", "unresolved #5"])(
    "does not match a keyword embedded in a longer word: %s",
    (body) => {
      expect(extractClosingIssueNumber(body)).toBeUndefined();
    }
  );

  it("still matches a keyword preceded by punctuation", () => {
    expect(extractClosingIssueNumber("(closes #88)")).toBe(88);
    expect(extractClosingIssueNumber("- Fixes #9")).toBe(9);
  });
});

import { describe, expect, it } from "vitest";
import { getAllIssueReferences } from "../forgeReferenceParsing";

const numbers = (text: string) => getAllIssueReferences(text).map((t) => t.number);

describe("getAllIssueReferences", () => {
  it("finds every bare #N with the range it spans", () => {
    const text = "Make sure to merge #14843 and #7.";
    const tokens = getAllIssueReferences(text);
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual(["#14843", "#7"]);
    expect(tokens.map((t) => t.number)).toEqual([14843, 7]);
  });

  it("takes a reference after punctuation or at a line start", () => {
    expect(numbers("#1\n(#2), [#3] #4: '#5' fixes:#6")).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([
    ["a heading", "# Heading"],
    ["a hex colour", "color: #fff"],
    ["a hex colour that starts with digits", "color: #123abc"],
    ["an include", "#include <stdio.h>"],
    ["a shebang", "#!/bin/bash"],
    ["a number inside a word", "abc#12 and PR#12"],
    ["a number inside a non-ASCII word", "café#12"],
    ["an HTML entity", "&#123;"],
    ["a URL fragment", "https://example.com/page/#12"],
    ["a URL query", "https://example.com/?page=#12"],
    ["a number after a combining mark", "e\u0301#12"],
    ["another repository's reference", "see owner/repo#12"],
    ["a run of #", "##12"],
    ["a leading zero", "#012 and #0"],
    ["more than nine digits", "#1234567890"],
    ["a number running into a word", "#12abc #12_x"],
  ])("leaves %s alone", (_, text) => {
    expect(numbers(text)).toEqual([]);
  });

  it("tells references apart from the URLs around them", () => {
    expect(numbers("https://x.test/?a=#1 #2 see https://y.test/#3, then #4")).toEqual([2, 4]);
  });

  it("keeps the largest number that fits a GraphQL Int", () => {
    expect(numbers("#999999999")).toEqual([999999999]);
  });
});

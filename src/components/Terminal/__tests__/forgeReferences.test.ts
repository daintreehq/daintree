import { describe, expect, it } from "vitest";
import type { Issue, PR } from "@shared/types/forge";
import {
  filterForgeReferences,
  formatForgeReference,
  toForgeReferences,
  type ForgeReference,
} from "../forgeReferences";

function issue(number: number, title: string, updatedAt: number, extra: Partial<Issue> = {}) {
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: `https://example.test/issues/${number}`,
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt,
    rawData: null,
    ...extra,
  } satisfies Issue;
}

function pr(number: number, title: string, updatedAt: number, extra: Partial<PR> = {}): PR {
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: `https://example.test/pull/${number}`,
    baseRef: "develop",
    headRef: `feature/${number}`,
    createdAt: 0,
    updatedAt,
    rawData: null,
    ...extra,
  } as PR;
}

function ref(number: number, title = `Item ${number}`, kind: "issue" | "pr" = "issue") {
  return { kind, number, title, state: "open", updatedAt: 0 } satisfies ForgeReference;
}

describe("toForgeReferences", () => {
  it("merges issues and pull requests, most recently updated first", () => {
    const refs = toForgeReferences(
      [issue(14842, "Old issue", 100), issue(14848, "New issue", 300)],
      [pr(14843, "Middle PR", 200)]
    );
    expect(refs.map((r) => [r.kind, r.number])).toEqual([
      ["issue", 14848],
      ["pr", 14843],
      ["issue", 14842],
    ]);
  });

  it("reports a draft pull request as a draft, and closed and merged ones as such", () => {
    const refs = toForgeReferences(
      [issue(1, "Closed", 4, { state: "closed" })],
      [
        pr(2, "Draft", 3, { isDraft: true }),
        pr(3, "Merged", 2, { state: "merged", merged: true }),
        pr(4, "Declined", 1, { state: "declined" }),
      ]
    );
    expect(refs.map((r) => [r.number, r.state])).toEqual([
      [1, "closed"],
      [2, "draft"],
      [3, "merged"],
      [4, "closed"],
    ]);
  });

  it("leaves out issues another tracker serves, whose numbers name nothing here", () => {
    const refs = toForgeReferences(
      [issue(12, "Linear issue", 5, { providerId: "daintree.linear.linear", key: "ENG-12" })],
      [pr(13, "A PR", 4)]
    );
    expect(refs.map((r) => r.number)).toEqual([13]);
  });
});

describe("filterForgeReferences", () => {
  const refs = [ref(14848), ref(14843), ref(14842), ref(1484), ref(9148)];

  it("returns everything for an empty query, up to the limit", () => {
    expect(filterForgeReferences(refs, "", 3).map((r) => r.number)).toEqual([14848, 14843, 14842]);
  });

  it("narrows digits by number prefix, never by digits inside the number", () => {
    expect(filterForgeReferences(refs, "148", 10).map((r) => r.number)).toEqual([
      14848, 14843, 14842, 1484,
    ]);
  });

  it("puts the exact number first", () => {
    expect(filterForgeReferences(refs, "1484", 10).map((r) => r.number)).toEqual([
      1484, 14848, 14843, 14842,
    ]);
  });

  it("matches a number with a leading zero to nothing", () => {
    expect(filterForgeReferences(refs, "0148", 10)).toEqual([]);
  });

  it("narrows words by the start of a title word, ignoring case", () => {
    const titled = [
      ref(1, "Suggest issues when typing #"),
      ref(2, "Fix the toolbar interface"),
      ref(3, "Toolbar: show counts"),
    ];
    expect(filterForgeReferences(titled, "tool", 10).map((r) => r.number)).toEqual([2, 3]);
    expect(filterForgeReferences(titled, "SUGG", 10).map((r) => r.number)).toEqual([1]);
    expect(filterForgeReferences(titled, "face", 10)).toEqual([]);
  });

  it("finds nothing for hex colours and shebangs", () => {
    const titled = [ref(1, "Add a colour picker"), ref(2, "Bash completion")];
    expect(filterForgeReferences(titled, "fff", 10)).toEqual([]);
    expect(filterForgeReferences(titled, "!/bin/bash", 10)).toEqual([]);
  });

  it("stops at the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => ref(100 + i, `Fix ${i}`));
    expect(filterForgeReferences(many, "fix", 4)).toHaveLength(4);
  });
});

describe("formatForgeReference", () => {
  it("is the number behind a hash, whatever the kind", () => {
    expect(formatForgeReference(ref(14843, "x", "pr"))).toBe("#14843");
    expect(formatForgeReference(ref(7))).toBe("#7");
  });
});

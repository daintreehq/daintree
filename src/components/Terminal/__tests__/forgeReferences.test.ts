import { describe, expect, it } from "vitest";
import type { Issue, PR } from "@shared/types/forge";
import { filterForgeReferences, toForgeReferences, type ForgeReference } from "../forgeReferences";

const GITHUB = { issue: "#", pr: "#" };

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
  };
}

function ref(number: number, title = `Item ${number}`): ForgeReference {
  return {
    kind: "issue",
    number,
    reference: `#${number}`,
    title,
    isDraft: false,
    updatedAt: 0,
  };
}

describe("toForgeReferences", () => {
  it("merges issues and pull requests, most recently updated first", () => {
    const refs = toForgeReferences(
      [issue(14842, "Old issue", 100), issue(14848, "New issue", 300)],
      [pr(14843, "Middle PR", 200)],
      GITHUB
    );
    expect(refs.map((r) => [r.kind, r.reference])).toEqual([
      ["issue", "#14848"],
      ["pr", "#14843"],
      ["issue", "#14842"],
    ]);
  });

  it("writes each kind with the prefix its forge declares", () => {
    const refs = toForgeReferences([issue(5, "An issue", 2)], [pr(5, "A merge request", 1)], {
      issue: "#",
      pr: "!",
    });
    expect(refs.map((r) => [r.kind, r.reference])).toEqual([
      ["issue", "#5"],
      ["pr", "!5"],
    ]);
  });

  it("leaves out a kind the forge declares no prefix for", () => {
    const refs = toForgeReferences([issue(1, "An issue", 2)], [pr(2, "A PR", 1)], { pr: "#" });
    expect(refs.map((r) => r.reference)).toEqual(["#2"]);
    expect(toForgeReferences([issue(1, "An issue", 2)], [pr(2, "A PR", 1)], {})).toEqual([]);
  });

  it("keeps drafts and drops anything no longer open", () => {
    const refs = toForgeReferences(
      [issue(1, "Closed", 7, { state: "closed" }), issue(2, "Open", 6)],
      [
        pr(3, "Draft", 5, { isDraft: true }),
        pr(4, "Merged by state", 4, { state: "merged" }),
        pr(5, "Merged by flag", 3, { merged: true }),
        pr(6, "Declined", 2, { state: "declined" }),
        pr(7, "Closed", 1, { state: "closed" }),
      ],
      GITHUB
    );
    expect(refs.map((r) => [r.number, r.isDraft])).toEqual([
      [2, false],
      [3, true],
    ]);
  });

  it("leaves out issues another tracker serves, whose numbers name nothing here", () => {
    const refs = toForgeReferences(
      [
        issue(12, "Linear issue", 5, { providerId: "daintree.linear.linear" }),
        issue(13, "Keyed issue", 4, { key: "ENG-13" }),
      ],
      [pr(14, "A PR", 3)],
      GITHUB
    );
    expect(refs.map((r) => r.number)).toEqual([14]);
  });

  it("orders ties by number, newest first", () => {
    const refs = toForgeReferences([issue(7, "A", 1)], [pr(9, "B", 1)], GITHUB);
    expect(refs.map((r) => r.number)).toEqual([9, 7]);
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

  it("keeps combining marks inside the word they belong to", () => {
    const titled = [ref(1, "किताब सूची"), ref(2, "Cafe\u0301 menu")];
    expect(filterForgeReferences(titled, "कि", 10).map((r) => r.number)).toEqual([1]);
    expect(filterForgeReferences(titled, "किताब", 10).map((r) => r.number)).toEqual([1]);
    expect(filterForgeReferences(titled, "café", 10).map((r) => r.number)).toEqual([2]);
    expect(filterForgeReferences(titled, "cafe\u0301", 10).map((r) => r.number)).toEqual([2]);
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

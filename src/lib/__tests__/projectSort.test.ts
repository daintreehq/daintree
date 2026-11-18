import { describe, it, expect } from "vitest";
import {
  compareProjectNames,
  compareProjectStrict,
  compareProjectsByMode,
  isOtherProjectsSortMode,
  OTHER_PROJECTS_SORT_MODES,
  type OtherProjectsSortMode,
  type SortableProject,
} from "../projectSort";

/**
 * One fixture where every signal disagrees, so each mode has to pick a
 * different winner. A fixture where score, recency and name happen to agree
 * would pass under any comparator and prove nothing.
 */
const CONFLICTING: SortableProject[] = [
  { id: "p-zulu", name: "Zulu", lastOpened: 300, frecencyScore: 9 },
  { id: "p-alpha", name: "Alpha", lastOpened: 100, frecencyScore: 3 },
  { id: "p-mike", name: "Mike", lastOpened: 500, frecencyScore: 1 },
];

function order(projects: SortableProject[], mode: OtherProjectsSortMode): string[] {
  return [...projects].sort((a, b) => compareProjectsByMode(a, b, mode)).map((p) => p.name);
}

describe("compareProjectsByMode", () => {
  it("ranks by decayed score in most used, ignoring which row was opened last", () => {
    // Mike is the most recently opened and still ranks last: score leads.
    expect(order(CONFLICTING, "mostUsed")).toEqual(["Zulu", "Alpha", "Mike"]);
  });

  it("ranks by last opened in recent, ignoring the score entirely", () => {
    expect(order(CONFLICTING, "recent")).toEqual(["Mike", "Zulu", "Alpha"]);
  });

  it("ranks by name in alphabetical, ignoring both score and recency", () => {
    expect(order(CONFLICTING, "alphabetical")).toEqual(["Alpha", "Mike", "Zulu"]);
  });

  it("compares names case-insensitively rather than by code point", () => {
    // A byte-wise compare puts every uppercase letter before every lowercase
    // one, which would file "apple" after "Banana".
    const mixed: SortableProject[] = [
      { id: "b", name: "Banana", lastOpened: 0, frecencyScore: 0 },
      { id: "a", name: "apple", lastOpened: 0, frecencyScore: 0 },
    ];
    expect(order(mixed, "alphabetical")).toEqual(["apple", "Banana"]);
  });

  it("does not consult the score in recent when timestamps tie", () => {
    // Score is the loudest signal in most used and must be silent here, or
    // "Recent" quietly becomes "Most used with extra steps" on any tie.
    const tied: SortableProject[] = [
      { id: "hi", name: "Zulu", lastOpened: 500, frecencyScore: 99 },
      { id: "lo", name: "Alpha", lastOpened: 500, frecencyScore: 1 },
    ];
    expect(order(tied, "recent")).toEqual(["Alpha", "Zulu"]);
  });

  it("reaches the name tie-break before the id in most used and recent", () => {
    // Ids are opaque and ordered against the names here, so skipping the name
    // comparison would surface them in the wrong order.
    const tied: SortableProject[] = [
      { id: "id-aaa", name: "Zulu", lastOpened: 500, frecencyScore: 5 },
      { id: "id-zzz", name: "Alpha", lastOpened: 500, frecencyScore: 5 },
    ];
    expect(order(tied, "mostUsed")).toEqual(["Alpha", "Zulu"]);
    expect(order(tied, "recent")).toEqual(["Alpha", "Zulu"]);
  });

  it("falls back to last opened when scores tie in most used", () => {
    const tied: SortableProject[] = [
      { id: "older", name: "Older", lastOpened: 100, frecencyScore: 5 },
      { id: "newer", name: "Newer", lastOpened: 900, frecencyScore: 5 },
    ];
    expect(order(tied, "mostUsed")).toEqual(["Newer", "Older"]);
  });

  it.each(OTHER_PROJECTS_SORT_MODES)("breaks a total tie deterministically in %s", (mode) => {
    // Same name, same score, same timestamp: without the id tie-break the
    // relative order would be whatever the sort implementation happened to do,
    // and rows could swap between renders for no visible reason.
    const twins: SortableProject[] = [
      { id: "id-b", name: "Same", lastOpened: 7, frecencyScore: 2 },
      { id: "id-a", name: "Same", lastOpened: 7, frecencyScore: 2 },
    ];
    const first = [...twins].sort((a, b) => compareProjectsByMode(a, b, mode));
    const second = [...twins].reverse().sort((a, b) => compareProjectsByMode(a, b, mode));
    expect(first.map((p) => p.id)).toEqual(["id-a", "id-b"]);
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
  });

  it.each(OTHER_PROJECTS_SORT_MODES)("is antisymmetric in %s", (mode) => {
    // Normalised to -1/0/1 rather than via `Math.sign`, whose negated zero is
    // `-0` — a distinction `toBe` (Object.is) would report as a failure.
    const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
    for (const a of CONFLICTING) {
      for (const b of CONFLICTING) {
        expect(sign(compareProjectsByMode(a, b, mode))).toBe(
          sign(-compareProjectsByMode(b, a, mode))
        );
      }
    }
  });
});

describe("isOtherProjectsSortMode", () => {
  it.each(OTHER_PROJECTS_SORT_MODES)("accepts %s", (mode) => {
    expect(isOtherProjectsSortMode(mode)).toBe(true);
  });

  it("rejects values a hand-edited or stale persisted blob could hold", () => {
    for (const value of [
      "",
      "hottest",
      "MostUsed",
      "frecency",
      null,
      undefined,
      0,
      {},
      ["mostUsed"],
    ]) {
      expect(isOtherProjectsSortMode(value)).toBe(false);
    }
  });
});

describe("shared collator comparators", () => {
  const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
  const samples = [
    "Alpha",
    "alpha",
    "Álpha",
    "alpha-2",
    "module-10.ts",
    "module-2.ts",
    "Zulu",
    "",
    "ß",
    "ss",
  ];

  it("orders names exactly like localeCompare with base sensitivity", () => {
    expect(compareProjectNames("Álpha", "alpha")).toBe(
      "Álpha".localeCompare("alpha", undefined, { sensitivity: "base" })
    );
    for (const a of samples) {
      for (const b of samples) {
        expect(sign(compareProjectNames(a, b))).toBe(
          sign(a.localeCompare(b, undefined, { sensitivity: "base" }))
        );
      }
    }
  });

  it.each(OTHER_PROJECTS_SORT_MODES)(
    "treats names differing only in case as equal in %s, so the id decides",
    (mode) => {
      expect(compareProjectNames("alpha", "ALPHA")).toBe(0);
      // Ids are assigned against the strict name order, so a caller that
      // compared names strictly would seat these the other way round.
      const names: [string, string] = ["alpha", "ALPHA"];
      const [strictFirst, strictSecond] = names.sort(compareProjectStrict);
      const projects: SortableProject[] = [
        { id: "a", name: strictSecond, lastOpened: 1, frecencyScore: 1 },
        { id: "b", name: strictFirst, lastOpened: 1, frecencyScore: 1 },
      ];
      for (const input of [projects, [...projects].reverse()]) {
        expect(order(input, mode)).toEqual([strictSecond, strictFirst]);
      }
    }
  );

  it("orders strictly like default localeCompare, still separating case and accents", () => {
    for (const a of samples) {
      for (const b of samples) {
        expect(sign(compareProjectStrict(a, b))).toBe(sign(a.localeCompare(b)));
      }
    }
    expect(compareProjectStrict("alpha", "ALPHA")).not.toBe(0);
  });
});

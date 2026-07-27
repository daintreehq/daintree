import { describe, it, expect } from "vitest";
import {
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
  it("ranks by decayed score in hottest, ignoring which row was opened last", () => {
    // Mike is the most recently opened and still ranks last: score leads.
    expect(order(CONFLICTING, "hottest")).toEqual(["Zulu", "Alpha", "Mike"]);
  });

  it("ranks by last opened in recent, ignoring the score entirely", () => {
    expect(order(CONFLICTING, "recent")).toEqual(["Mike", "Zulu", "Alpha"]);
  });

  it("ranks by name in alphabetical, ignoring both score and recency", () => {
    expect(order(CONFLICTING, "alphabetical")).toEqual(["Alpha", "Mike", "Zulu"]);
  });

  it("gives each mode a distinct order for the same input", () => {
    const orders = OTHER_PROJECTS_SORT_MODES.map((mode) => order(CONFLICTING, mode).join("|"));
    expect(new Set(orders).size).toBe(OTHER_PROJECTS_SORT_MODES.length);
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
    // Score is the loudest signal in hottest and must be silent here, or
    // "Recent" quietly becomes "Hottest with extra steps" on any tie.
    const tied: SortableProject[] = [
      { id: "hi", name: "Zulu", lastOpened: 500, frecencyScore: 99 },
      { id: "lo", name: "Alpha", lastOpened: 500, frecencyScore: 1 },
    ];
    expect(order(tied, "recent")).toEqual(["Alpha", "Zulu"]);
  });

  it("reaches the name tie-break before the id in hottest and recent", () => {
    // Ids are opaque and ordered against the names here, so skipping the name
    // comparison would surface them in the wrong order.
    const tied: SortableProject[] = [
      { id: "id-aaa", name: "Zulu", lastOpened: 500, frecencyScore: 5 },
      { id: "id-zzz", name: "Alpha", lastOpened: 500, frecencyScore: 5 },
    ];
    expect(order(tied, "hottest")).toEqual(["Alpha", "Zulu"]);
    expect(order(tied, "recent")).toEqual(["Alpha", "Zulu"]);
  });

  it("does not let score or recency leak into alphabetical", () => {
    const mixed: SortableProject[] = [
      { id: "a", name: "Alpha", lastOpened: 1, frecencyScore: 0 },
      { id: "z", name: "Zulu", lastOpened: 999, frecencyScore: 99 },
    ];
    expect(order(mixed, "alphabetical")).toEqual(["Alpha", "Zulu"]);
  });

  it("falls back to last opened when scores tie in hottest", () => {
    const tied: SortableProject[] = [
      { id: "older", name: "Older", lastOpened: 100, frecencyScore: 5 },
      { id: "newer", name: "Newer", lastOpened: 900, frecencyScore: 5 },
    ];
    expect(order(tied, "hottest")).toEqual(["Newer", "Older"]);
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
    for (const value of ["", "Hottest", "frecency", null, undefined, 0, {}, ["hottest"]]) {
      expect(isOtherProjectsSortMode(value)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { describeHeardAsConflicts } from "../heardAsConflictCopy";

describe("describeHeardAsConflicts", () => {
  it("names the term each phrase belongs to, grouping phrases by term in order", () => {
    expect(describeHeardAsConflicts([{ phrase: "zoo stand", owner: "Zustand" }])).toBe(
      "“zoo stand” already belongs to Zustand"
    );
    expect(
      describeHeardAsConflicts([
        { phrase: "zoo stand", owner: "Zustand" },
        { phrase: "vee", owner: "Vite" },
        { phrase: "zoo-stand", owner: "Zustand" },
        { phrase: "veet", owner: "Vite" },
        { phrase: "v test", owner: "Vite" },
      ])
    ).toBe(
      "“zoo stand” and “zoo-stand” already belong to Zustand; “vee”, “veet” and “v test” to Vite"
    );
  });

  it("counts the phrases past the limit", () => {
    const conflicts = ["a", "b", "c", "d"].map((phrase) => ({ phrase, owner: "Term" }));
    expect(describeHeardAsConflicts(conflicts, 2)).toBe(
      "“a” and “b” already belong to Term, and 2 more"
    );
    expect(describeHeardAsConflicts(conflicts, 4)).toBe(
      "“a”, “b”, “c” and “d” already belong to Term"
    );
  });
});

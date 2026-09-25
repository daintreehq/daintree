import { describe, it, expect } from "vitest";
import { selectButtonDescribedBy, worktreeRowDescriptionId } from "../rowDescriptions";

const PATH = "/Users/dev/My Projects/helios-worktrees/retry jitter";
const none = { lifecycle: false, alarm: false, external: false };

describe("worktreeRowDescriptionId", () => {
  it("makes one IDREF of a path with spaces in it", () => {
    // aria-describedby is a space-separated list: a raw path would point at
    // several ids, none of them this one.
    for (const part of ["lifecycle", "alarm", "external"] as const) {
      expect(worktreeRowDescriptionId(PATH, part)).not.toMatch(/\s/);
    }
  });

  it("gives every mark on a row its own id", () => {
    const ids = (["lifecycle", "alarm", "external"] as const).map((part) =>
      worktreeRowDescriptionId(PATH, part)
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives two worktrees two ids for the same mark", () => {
    expect(worktreeRowDescriptionId("/a/b c", "alarm")).not.toBe(
      worktreeRowDescriptionId("/a/b-c", "alarm")
    );
  });
});

describe("selectButtonDescribedBy", () => {
  it("references only the marks that are mounted", () => {
    // Anything else is a dangling IDREF.
    const describedBy = selectButtonDescribedBy(PATH, { ...none, alarm: true, external: true });
    expect(describedBy?.split(" ")).toEqual([
      worktreeRowDescriptionId(PATH, "alarm"),
      worktreeRowDescriptionId(PATH, "external"),
    ]);
  });

  it("omits the attribute when the row has no marks", () => {
    expect(selectButtonDescribedBy(PATH, none)).toBeUndefined();
  });

  it("speaks the lifecycle mark first and the location last", () => {
    // Asking-for-me outranks something-is-wrong, which outranks where it lives.
    const ids = selectButtonDescribedBy(PATH, {
      lifecycle: true,
      alarm: true,
      external: true,
    })!.split(" ");
    expect(ids.indexOf(worktreeRowDescriptionId(PATH, "lifecycle"))).toBe(0);
    expect(ids.indexOf(worktreeRowDescriptionId(PATH, "external"))).toBe(ids.length - 1);
  });
});

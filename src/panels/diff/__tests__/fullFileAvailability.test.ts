import { describe, expect, it } from "vitest";
import type { GitStatus } from "@shared/types/git";
import { getFullFileAvailability } from "../fullFileAvailability";

describe("getFullFileAvailability", () => {
  it("offers the whole file for edits to a file that exists on disk", () => {
    for (const status of ["modified", "renamed", "copied"] as GitStatus[]) {
      expect(getFullFileAvailability("working-tree", status).available).toBe(true);
      expect(getFullFileAvailability("unstaged", status).available).toBe(true);
    }
  });

  it("treats a missing source and status the way buildSubject does", () => {
    // buildSubject defaults to working-tree/modified, so the toolbar must not
    // disagree with the diff that actually gets fetched.
    expect(getFullFileAvailability(undefined, undefined).available).toBe(true);
  });

  it("refuses staged diffs, whose new side is the index rather than the disk file", () => {
    const result = getFullFileAvailability("staged", "modified");
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toMatch(/index/i);
  });

  it("refuses base-branch diffs, whose new side isn't on disk", () => {
    const result = getFullFileAvailability("base-branch", "modified");
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toMatch(/base-branch/i);
  });

  it("refuses statuses whose diff already carries every line", () => {
    for (const status of ["added", "untracked"] as GitStatus[]) {
      const result = getFullFileAvailability("working-tree", status);
      expect(result.available).toBe(false);
      expect(result.available === false && result.reason).toMatch(/already/i);
    }
  });

  it("refuses a deleted file, which has no current version", () => {
    const result = getFullFileAvailability("working-tree", "deleted");
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toMatch(/deleted/i);
  });

  it("refuses statuses the diff renderer can't expand", () => {
    // DiffViewer only builds an old-side source for modify/rename/copy; the
    // toolbar must not offer a scope the renderer would then refuse.
    for (const status of ["conflicted", "ignored"] as GitStatus[]) {
      expect(getFullFileAvailability("working-tree", status).available).toBe(false);
    }
  });

  it("refuses a submodule gitlink, whose path is a directory rather than a file", () => {
    // The reported bug: status `modified` on a working-tree diff looked like an
    // ordinary edit, so the scope was offered and the read failed (#12309).
    const result = getFullFileAvailability("working-tree", "modified", true);
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toMatch(/submodule/i);
  });

  it("outranks every other reason, so a submodule always says submodule", () => {
    // An added gitlink would otherwise be told its diff already carries the
    // whole file — true of a file, meaningless for a commit reference.
    for (const status of ["added", "deleted", "renamed", "conflicted"] as GitStatus[]) {
      const result = getFullFileAvailability("working-tree", status, true);
      expect(result.available === false && result.reason).toMatch(/submodule/i);
    }
    const staged = getFullFileAvailability("staged", "modified", true);
    expect(staged.available === false && staged.reason).toMatch(/submodule/i);
  });

  it("leaves ordinary files untouched when the flag is absent or false", () => {
    expect(getFullFileAvailability("working-tree", "modified", false).available).toBe(true);
    expect(getFullFileAvailability("working-tree", "modified").available).toBe(true);
  });

  it("always explains itself when it says no", () => {
    const sources = ["working-tree", "unstaged", "staged", "base-branch", undefined] as const;
    const statuses: (GitStatus | undefined)[] = [
      "modified",
      "added",
      "deleted",
      "untracked",
      "renamed",
      "copied",
      "conflicted",
      "ignored",
      undefined,
    ];
    for (const source of sources) {
      for (const status of statuses) {
        const result = getFullFileAvailability(source, status);
        if (!result.available) expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

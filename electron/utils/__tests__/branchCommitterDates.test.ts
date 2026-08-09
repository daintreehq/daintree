import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  branchRefName,
  parseBranchCommitterDates,
  readBranchCommitterDates,
} from "../branchCommitterDates.js";

const TAB = "\t";

describe("parseBranchCommitterDates", () => {
  it("keys dates by their full refname", () => {
    const dates = parseBranchCommitterDates(
      [
        `refs/heads/main${TAB}2026-08-01T10:00:00+00:00`,
        `refs/remotes/origin/main${TAB}2026-07-30T09:00:00+00:00`,
      ].join("\n")
    );

    expect(dates.get("refs/heads/main")).toBe("2026-08-01T10:00:00+00:00");
    expect(dates.get("refs/remotes/origin/main")).toBe("2026-07-30T09:00:00+00:00");
  });

  it("keeps a local branch named like a remote distinct from the remote one", () => {
    // Both collapse to the short name `origin/foo`, so short keys would hand one
    // branch the other's date.
    const dates = parseBranchCommitterDates(
      [
        `refs/heads/origin/foo${TAB}2026-08-01T10:00:00+00:00`,
        `refs/remotes/origin/foo${TAB}2026-01-01T10:00:00+00:00`,
      ].join("\n")
    );

    expect(dates.get("refs/heads/origin/foo")).toBe("2026-08-01T10:00:00+00:00");
    expect(dates.get("refs/remotes/origin/foo")).toBe("2026-01-01T10:00:00+00:00");
  });

  it("preserves slashes and dots inside branch names", () => {
    const dates = parseBranchCommitterDates(
      `refs/heads/feature/foo.bar-baz${TAB}2026-08-01T10:00:00+00:00`
    );
    expect(dates.get("refs/heads/feature/foo.bar-baz")).toBe("2026-08-01T10:00:00+00:00");
  });

  it("skips lines with no separator, no ref, or no date", () => {
    const dates = parseBranchCommitterDates(
      [
        "refs/heads/no-separator",
        `${TAB}2026-08-01T10:00:00+00:00`,
        `refs/heads/no-date${TAB}`,
        "",
        `refs/heads/good${TAB}2026-08-01T10:00:00+00:00`,
      ].join("\n")
    );

    expect(Array.from(dates.keys())).toEqual(["refs/heads/good"]);
  });

  it("returns nothing for absent output rather than throwing", () => {
    expect(parseBranchCommitterDates(undefined).size).toBe(0);
    expect(parseBranchCommitterDates(null).size).toBe(0);
    expect(parseBranchCommitterDates("").size).toBe(0);
  });
});

describe("readBranchCommitterDates", () => {
  it("asks git for both local and remote refs in one pass", async () => {
    const raw = vi.fn().mockResolvedValue(`refs/heads/main${TAB}2026-08-01T10:00:00+00:00`);

    const dates = await readBranchCommitterDates({ raw });

    expect(dates.get("refs/heads/main")).toBe("2026-08-01T10:00:00+00:00");
    const args = raw.mock.calls[0]![0] as string[];
    expect(args[0]).toBe("for-each-ref");
    expect(args).toContain("refs/heads");
    expect(args).toContain("refs/remotes");
    // One spawn for the whole list — per-branch ahead/behind would need one each.
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("degrades to no dates when git fails, so the branch list still loads", async () => {
    const raw = vi.fn().mockRejectedValue(new Error("not a git repository"));

    await expect(readBranchCommitterDates({ raw })).resolves.toEqual(new Map());
  });

  it("tolerates a git client that resolves with nothing", async () => {
    const raw = vi.fn().mockResolvedValue(undefined);
    await expect(readBranchCommitterDates({ raw })).resolves.toEqual(new Map());
  });
});

describe("branchRefName", () => {
  it("maps a display name back to the ref the date map is keyed by", () => {
    expect(branchRefName("main", false)).toBe("refs/heads/main");
    expect(branchRefName("origin/main", true)).toBe("refs/remotes/origin/main");
  });

  it("distinguishes the two spellings of the same short name", () => {
    expect(branchRefName("origin/foo", false)).not.toBe(branchRefName("origin/foo", true));
  });
});

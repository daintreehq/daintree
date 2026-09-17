import { describe, it, expect } from "vitest";
import {
  getWorktreeHeadline,
  getWorktreeBranchLabel,
  isMainWorktreeOnStandardBranch,
} from "../worktreeHeadline";
import type { Worktree, WorktreeState } from "@shared/types/worktree";

const createWorktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: "test-id",
  path: "/home/user/project",
  name: "project",
  branch: "feature/thing",
  isCurrent: false,
  isMainWorktree: false,
  ...overrides,
});

/** A linked PR as the forge cache stores it, with or without a fetched title. */
const withLinkedPr = (number: number, title?: string): Partial<Worktree> => ({
  linked: {
    providerId: "github",
    pr: {
      ref: { providerId: "github", owner: "test", repo: "test", number, rawData: {} },
      state: "open",
      url: `https://github.com/test/test/pull/${number}`,
      ...(title !== undefined ? { title } : {}),
    },
  },
});

describe("getWorktreeHeadline — PR-originated", () => {
  it("leads with the linked PR title", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ sourcePrNumber: 123, ...withLinkedPr(123, "Fix the thing") })
    );
    expect(headline).toEqual({
      kind: "pr",
      number: 123,
      title: "Fix the thing",
      label: "#123 Fix the thing",
    });
  });

  it("falls back to the flat prTitle when there is no linked PR yet", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ sourcePrNumber: 123, prTitle: "Cached title" })
    );
    expect(headline).toEqual({
      kind: "pr",
      number: 123,
      title: "Cached title",
      label: "#123 Cached title",
    });
  });

  it("renders the bare number while the title is still cold", () => {
    const headline = getWorktreeHeadline(createWorktree({ sourcePrNumber: 123 }));
    expect(headline).toEqual({ kind: "pr", number: 123, title: undefined, label: "#123" });
  });

  it("lets an explicitly empty linked title suppress the flat prTitle", () => {
    // `??` only falls through on null/undefined, so an empty linked title is a
    // deliberate "no title", not a miss.
    const headline = getWorktreeHeadline(
      createWorktree({ sourcePrNumber: 123, prTitle: "Stale", ...withLinkedPr(123, "") })
    );
    expect(headline).toEqual({ kind: "pr", number: 123, title: "", label: "#123" });
  });

  it("outranks issue metadata on the same worktree", () => {
    const headline = getWorktreeHeadline(
      createWorktree({
        sourcePrNumber: 7,
        prTitle: "PR wins",
        issueNumber: 42,
        issueTitle: "Issue loses",
      })
    );
    expect(headline.kind).toBe("pr");
  });

  it("does not treat a merely linked PR as PR-originated", () => {
    // `sourcePrNumber` is the discriminator, not the presence of a linked PR.
    const headline = getWorktreeHeadline(
      createWorktree({ issueNumber: 42, issueTitle: "Issue", ...withLinkedPr(99, "Some PR") })
    );
    expect(headline).toEqual({ kind: "issue", number: 42, title: "Issue", label: "#42 Issue" });
  });
});

describe("getWorktreeHeadline — issue", () => {
  it("uses the fetched issue title", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ issueNumber: 456, issueTitle: "Real title" })
    );
    expect(headline).toEqual({
      kind: "issue",
      number: 456,
      title: "Real title",
      label: "#456 Real title",
    });
  });

  it("falls back to the branch-derived title", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ issueNumber: 456, branchDerivedTitle: "Derived title" })
    );
    expect(headline).toEqual({
      kind: "issue",
      number: 456,
      title: "Derived title",
      label: "#456 Derived title",
    });
  });

  it("falls through to the branch when the number has no title anywhere", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ issueNumber: 456, branch: "feature/thing" })
    );
    expect(headline).toEqual({ kind: "branch", label: "feature/thing" });
  });

  it("falls through to the branch when a title has no issue number", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ issueTitle: "Orphan title", branch: "feature/thing" })
    );
    expect(headline).toEqual({ kind: "branch", label: "feature/thing" });
  });

  it("lets an explicitly empty issueTitle suppress the branch-derived fallback", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ issueNumber: 456, issueTitle: "", branchDerivedTitle: "Derived" })
    );
    expect(headline).toEqual({ kind: "branch", label: "feature/thing" });
  });
});

describe("getWorktreeHeadline — main on a standard branch", () => {
  it("names the project rather than the branch", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ isMainWorktree: true, name: "daintree", branch: "main" })
    );
    expect(headline).toEqual({ kind: "main", label: "daintree" });
  });

  it.each(["main", "master", "develop", "dev", "MAIN", "Develop"])(
    "treats %s as a standard branch",
    (branch) => {
      expect(
        getWorktreeHeadline(createWorktree({ isMainWorktree: true, name: "daintree", branch }))
      ).toEqual({ kind: "main", label: "daintree" });
    }
  );

  it("does not treat a near miss like development as standard", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ isMainWorktree: true, name: "daintree", branch: "development" })
    );
    expect(headline).toEqual({ kind: "branch", label: "development" });
  });

  it("still yields to an issue headline", () => {
    const headline = getWorktreeHeadline(
      createWorktree({
        isMainWorktree: true,
        name: "daintree",
        branch: "main",
        issueNumber: 1,
        issueTitle: "Something",
      })
    );
    expect(headline.kind).toBe("issue");
  });

  it("falls back to the name for a detached main carrying a stale branch", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ isMainWorktree: true, name: "daintree", branch: "main", isDetached: true })
    );
    expect(headline).toEqual({ kind: "branch", label: "daintree" });
  });

  it("falls back to the name for a branchless main", () => {
    const headline = getWorktreeHeadline(
      createWorktree({ isMainWorktree: true, name: "daintree", branch: undefined })
    );
    expect(headline).toEqual({ kind: "branch", label: "daintree" });
  });
});

describe("getWorktreeHeadline — branch", () => {
  it("uses the branch for a non-main worktree", () => {
    expect(getWorktreeHeadline(createWorktree({ branch: "bugfix/thing" }))).toEqual({
      kind: "branch",
      label: "bugfix/thing",
    });
  });

  it("falls back to the name for a branchless non-main worktree", () => {
    expect(getWorktreeHeadline(createWorktree({ name: "orphan", branch: undefined }))).toEqual({
      kind: "branch",
      label: "orphan",
    });
  });

  it("keeps the stale branch for a detached non-main worktree", () => {
    // Only main swaps to its name when detached; the rest keep what the
    // snapshot last read, matching `useWorktreeStatus`.
    expect(
      getWorktreeHeadline(createWorktree({ branch: "feature/gone", isDetached: true }))
    ).toEqual({ kind: "branch", label: "feature/gone" });
  });

  it("supplies the Untitled worktree fallback when the label trims to nothing", () => {
    expect(getWorktreeHeadline(createWorktree({ name: "   ", branch: "  " }))).toEqual({
      kind: "branch",
      label: "Untitled worktree",
    });
  });

  it("accepts a WorktreeState as readily as a Worktree", () => {
    const state: WorktreeState = {
      ...createWorktree({ branch: "feature/state" }),
      worktreeChanges: null,
      lastActivityTimestamp: null,
    } as WorktreeState;
    expect(getWorktreeHeadline(state)).toEqual({ kind: "branch", label: "feature/state" });
  });
});

describe("getWorktreeBranchLabel", () => {
  it("uses the branch for main when it is checked out", () => {
    expect(
      getWorktreeBranchLabel(
        createWorktree({ isMainWorktree: true, name: "daintree", branch: "main" })
      )
    ).toBe("main");
  });

  it("uses the name for a detached main", () => {
    expect(
      getWorktreeBranchLabel(
        createWorktree({ isMainWorktree: true, name: "daintree", branch: "main", isDetached: true })
      )
    ).toBe("daintree");
  });

  it("uses the name for a branchless main", () => {
    expect(
      getWorktreeBranchLabel(
        createWorktree({ isMainWorktree: true, name: "daintree", branch: undefined })
      )
    ).toBe("daintree");
  });

  it("uses the branch for a non-main worktree, detached or not", () => {
    expect(getWorktreeBranchLabel(createWorktree({ branch: "feature/x" }))).toBe("feature/x");
    expect(getWorktreeBranchLabel(createWorktree({ branch: "feature/x", isDetached: true }))).toBe(
      "feature/x"
    );
  });

  it("uses the name for a branchless non-main worktree", () => {
    expect(getWorktreeBranchLabel(createWorktree({ name: "orphan", branch: undefined }))).toBe(
      "orphan"
    );
  });

  it("returns the label raw, without trimming or inventing a fallback", () => {
    // The compact headline adds "Untitled worktree"; this helper must not, or
    // every caller rendering it verbatim would inherit words it never chose.
    expect(getWorktreeBranchLabel(createWorktree({ name: "orphan", branch: "  " }))).toBe("  ");
  });
});

describe("isMainWorktreeOnStandardBranch", () => {
  it("is true only for a main worktree on a checked-out standard branch", () => {
    expect(
      isMainWorktreeOnStandardBranch(createWorktree({ isMainWorktree: true, branch: "develop" }))
    ).toBe(true);
  });

  it.each([
    ["a non-main worktree", { isMainWorktree: false, branch: "main" }],
    ["a non-standard branch", { isMainWorktree: true, branch: "feature/x" }],
    ["a detached main", { isMainWorktree: true, branch: "main", isDetached: true }],
    ["a branchless main", { isMainWorktree: true, branch: undefined }],
  ])("is false for %s", (_label, overrides) => {
    expect(isMainWorktreeOnStandardBranch(createWorktree(overrides))).toBe(false);
  });
});

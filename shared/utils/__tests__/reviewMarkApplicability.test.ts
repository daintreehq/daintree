import { describe, expect, it } from "vitest";
import { reviewMarkApplicability } from "../reviewMarkApplicability.js";

const COMMIT = "1".repeat(40);

describe("reviewMarkApplicability", () => {
  const onBranch = { kind: "branch", branch: "topic", commit: COMMIT } as const;
  const unborn = { kind: "unborn", branch: "topic" } as const;
  const detached = { kind: "detached", commit: COMMIT } as const;

  it("applies a branch mark only while the worktree is on that branch", () => {
    expect(reviewMarkApplicability(onBranch, { branch: "topic" })).toBe("applicable");
    expect(reviewMarkApplicability(unborn, { branch: "topic" })).toBe("applicable");
    expect(reviewMarkApplicability(onBranch, { branch: "Topic" })).toBe("branch-changed");
    expect(reviewMarkApplicability(onBranch, { branch: "topic", isDetached: true })).toBe(
      "branch-changed"
    );
  });

  it("applies a detached mark only while the worktree is detached", () => {
    expect(reviewMarkApplicability(detached, { isDetached: true })).toBe("applicable");
    expect(reviewMarkApplicability(detached, { branch: "topic" })).toBe("branch-changed");
  });

  it("applies nothing while the worktree's branch isn't known", () => {
    expect(reviewMarkApplicability(onBranch, {})).toBe("branch-unknown");
    expect(reviewMarkApplicability(detached, { branch: "" })).toBe("branch-unknown");
  });
});

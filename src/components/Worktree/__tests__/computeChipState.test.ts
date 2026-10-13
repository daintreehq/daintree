import { describe, expect, it } from "vitest";
import { computeChipState } from "../utils/computeChipState";
import {
  EMPTY_WORKTREE_AGENT_BUCKETS,
  type WorktreeAgentBuckets,
} from "@/lib/worktreeAgentBuckets";

const buckets = (overrides: Partial<WorktreeAgentBuckets>): WorktreeAgentBuckets => ({
  ...EMPTY_WORKTREE_AGENT_BUCKETS,
  ...overrides,
});

describe("computeChipState", () => {
  it("returns null with no bucket", () => {
    expect(computeChipState(EMPTY_WORKTREE_AGENT_BUCKETS)).toBeNull();
  });

  it("returns null for a worktree that is only working", () => {
    expect(computeChipState(buckets({ working: true }))).toBeNull();
  });

  it("returns attention when an agent is asking, even beside a working one", () => {
    expect(computeChipState(buckets({ attention: true, working: true }))).toBe("attention");
  });

  it("returns cleanup for a merged worktree", () => {
    expect(computeChipState(buckets({ finished: true, cleanup: true }))).toBe("cleanup");
  });

  it("returns finished for an unseen hand-back", () => {
    expect(computeChipState(buckets({ finished: true, finishedUnseen: true }))).toBe("finished");
  });

  it("returns null once every hand-back has been seen", () => {
    expect(computeChipState(buckets({ finished: true }))).toBeNull();
  });

  it("prefers cleanup over an unseen hand-back", () => {
    expect(computeChipState(buckets({ finished: true, finishedUnseen: true, cleanup: true }))).toBe(
      "cleanup"
    );
  });
});

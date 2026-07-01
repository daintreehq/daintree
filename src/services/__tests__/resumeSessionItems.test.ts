import { describe, it, expect } from "vitest";
import {
  buildResumeSessionItems,
  snapshotTeaser,
  pathBasename,
  prettifyModelId,
  NO_WORKTREE_GROUP_KEY,
  type ResumeWorktreeLike,
} from "../resumeSessionItems";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

function rec(over: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: "s1",
    agentId: "test-agent",
    worktreeId: "wt1",
    title: null,
    projectId: "p1",
    savedAt: 1_700_000_000_000,
    ...over,
  };
}

const worktrees = new Map<string, ResumeWorktreeLike>([
  ["wt1", { name: "feature-a", branch: "feat/a" }],
  ["wt2", { name: "feature-b", branch: "feat/b" }],
]);

describe("buildResumeSessionItems", () => {
  it("scopes to the current project by projectId", () => {
    const items = buildResumeSessionItems(
      [rec({ sessionId: "a", projectId: "p1" }), rec({ sessionId: "b", projectId: "p2" })],
      { currentProjectId: "p1", worktrees }
    );
    expect(items.map((i) => i.session.sessionId)).toEqual(["a"]);
  });

  it("keeps legacy null-project records only when their worktree resolves", () => {
    const items = buildResumeSessionItems(
      [
        rec({ sessionId: "keep", projectId: null, worktreeId: "wt1" }),
        rec({ sessionId: "drop", projectId: null, worktreeId: "unknown" }),
      ],
      { currentProjectId: "p1", worktrees }
    );
    expect(items.map((i) => i.session.sessionId)).toEqual(["keep"]);
  });

  it("flags a same-project record whose worktree no longer resolves as stale", () => {
    const [item] = buildResumeSessionItems([rec({ worktreeId: "gone", branch: "old/branch" })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(item?.isStale).toBe(true);
    // Stale rows fall back to a recorded-branch label so they stay identifiable.
    expect(item?.groupLabel).toBe("old/branch");
  });

  it("groups by live worktree with its display name, and non-worktree records under a sentinel", () => {
    const items = buildResumeSessionItems(
      [rec({ sessionId: "a", worktreeId: "wt1" }), rec({ sessionId: "b", worktreeId: null })],
      { currentProjectId: "p1", worktrees }
    );
    const byId = new Map(items.map((i) => [i.session.sessionId, i]));
    expect(byId.get("a")?.groupKey).toBe("wt1");
    expect(byId.get("a")?.groupLabel).toBe("feature-a");
    expect(byId.get("a")?.isStale).toBe(false);
    expect(byId.get("b")?.groupKey).toBe(NO_WORKTREE_GROUP_KEY);
    expect(byId.get("b")?.groupLabel).toBe("No worktree");
  });

  it("titles the row from a meaningful title, else falls back to the agent name", () => {
    const [withTitle] = buildResumeSessionItems([rec({ title: "Fix the auth bug" })], {
      currentProjectId: "p1",
      worktrees,
    });
    const [noTitle] = buildResumeSessionItems([rec({ title: null })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(withTitle?.name).toBe("Resume: Fix the auth bug");
    expect(noTitle?.name).toBe("Resume test-agent");
  });

  it("derives a teaser from a captured snapshot and null when none", () => {
    const [withSnap] = buildResumeSessionItems([rec({ snapshot: "building…\nDone in 2s" })], {
      currentProjectId: "p1",
      worktrees,
    });
    const [noSnap] = buildResumeSessionItems([rec({ snapshot: undefined })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(withSnap?.teaser).toContain("Done in 2s");
    expect(noSnap?.teaser).toBeNull();
  });
});

describe("snapshotTeaser", () => {
  it("returns null for empty or missing input", () => {
    expect(snapshotTeaser(undefined)).toBeNull();
    expect(snapshotTeaser(null)).toBeNull();
    expect(snapshotTeaser("   \n  ")).toBeNull();
  });

  it("takes the last non-blank lines and collapses whitespace", () => {
    expect(snapshotTeaser("first\n\nsecond\nthird", { maxLines: 2 })).toBe("second third");
  });

  it("caps the length with an ellipsis", () => {
    const teaser = snapshotTeaser("x".repeat(500), { maxLen: 10 });
    expect(teaser).toBe(`${"x".repeat(10)}…`);
  });
});

describe("pathBasename", () => {
  it("returns the last segment for posix and windows paths, empty for none", () => {
    expect(pathBasename("/a/b/c")).toBe("c");
    expect(pathBasename("C:\\projects\\daintree")).toBe("daintree");
    expect(pathBasename("")).toBe("");
    expect(pathBasename(undefined)).toBe("");
  });
});

describe("prettifyModelId", () => {
  it("strips the provider prefix and claude- prefix, then title-cases", () => {
    expect(prettifyModelId("anthropic/claude-opus-4-8")).toBe("Opus 4 8");
    expect(prettifyModelId("gpt-5.5")).toBe("Gpt 5.5");
  });
});

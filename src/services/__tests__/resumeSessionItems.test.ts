import { describe, it, expect } from "vitest";
import {
  buildResumeSessionItems,
  pathBasename,
  prettifyModelId,
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
  ["wt1", { name: "feature-a", branch: "feat/a", path: "/repo/wt-a" }],
  ["wt2", { name: "feature-b", branch: "feat/b", path: "/repo/wt-b" }],
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

  it("keeps a legacy null-project, null-worktree record when its cwd resolves to a live worktree", () => {
    const items = buildResumeSessionItems(
      [
        rec({ sessionId: "keep", projectId: null, worktreeId: null, cwd: "/repo/wt-a/src" }),
        rec({ sessionId: "drop", projectId: null, worktreeId: null, cwd: "/somewhere/else" }),
        rec({ sessionId: "drop2", projectId: null, worktreeId: null }),
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
    expect(item?.description).toContain("Worktree removed");
  });

  it("keeps a stale entry findable by its cwd basename when it has no branch", () => {
    const [item] = buildResumeSessionItems(
      [rec({ worktreeId: "gone", branch: undefined, cwd: "/repo/feature-auth" })],
      { currentProjectId: "p1", worktrees }
    );
    expect(item?.isStale).toBe(true);
    expect(item?.searchAliases).toContain("feature-auth");
  });

  it("re-homes a null-worktree record onto the live worktree containing its cwd", () => {
    const [item] = buildResumeSessionItems(
      [rec({ worktreeId: null, cwd: "/repo/wt-a/packages/core" })],
      { currentProjectId: "p1", worktrees }
    );
    expect(item?.isStale).toBe(false);
    expect(item?.worktreeName).toBe("feature-a");
    expect(item?.branchName).toBe("feat/a");
    expect(item?.description).toContain("feature-a");
  });

  it("never marks a null-worktree record stale, even when its cwd resolves nowhere", () => {
    const [item] = buildResumeSessionItems([rec({ worktreeId: null, cwd: "/tmp/elsewhere" })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(item?.isStale).toBe(false);
    expect(item?.worktreeName).toBeUndefined();
  });

  it("resolves the live worktree's display name and branch for recorded worktrees", () => {
    const [item] = buildResumeSessionItems([rec({ worktreeId: "wt1" })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(item?.isStale).toBe(false);
    expect(item?.worktreeName).toBe("feature-a");
    expect(item?.branchName).toBe("feat/a");
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

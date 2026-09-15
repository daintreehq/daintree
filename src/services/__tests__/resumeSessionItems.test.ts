import { describe, it, expect } from "vitest";
import {
  buildResumeSessionItems,
  isAgentPlaceholderTitle,
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
    // The row says where it ran; the heading it sits under says the worktree
    // is gone. Saying it on the row too is how it came to be printed twice.
    expect(item?.location).toBe("old/branch");
    expect(item?.description).not.toContain("Worktree removed");
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
    expect(withTitle?.title).toBe("Fix the auth bug");
    expect(withTitle?.hasTitle).toBe(true);
    expect(withTitle?.name).toBe("Resume: Fix the auth bug");
    expect(noTitle?.title).toBe("test-agent session");
    expect(noTitle?.hasTitle).toBe(false);
    expect(noTitle?.name).toBe("Resume test-agent session");
  });

  it("treats an agent's own product name as no title", () => {
    // Claude Code sits on "Claude Code" until it has a task to summarise; a
    // row titled that way carries nothing the agent glyph beside it does not.
    const [item] = buildResumeSessionItems([rec({ agentId: "claude", title: "✳ Claude Code" })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(item?.hasTitle).toBe(false);
    expect(item?.title).toBe("Claude session");
  });

  it("carries the agent name for the accessible label, registered or not", () => {
    const [claude] = buildResumeSessionItems([rec({ agentId: "claude", title: "Fix it" })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(claude?.agentName).toBe("Claude");
    // An unregistered agent is named by its id, and that id is its placeholder title.
    const [custom] = buildResumeSessionItems([rec({ agentId: "my-agent", title: "my-agent" })], {
      currentProjectId: "p1",
      worktrees,
    });
    expect(custom?.agentName).toBe("my-agent");
    expect(custom?.hasTitle).toBe(false);
    expect(custom?.title).toBe("my-agent session");
  });

  it("keeps the agent out of the metadata line — the glyph already says it", () => {
    const [item] = buildResumeSessionItems(
      [rec({ agentId: "claude", title: "Fix the auth bug", agentModelId: "claude-opus-4-8" })],
      { currentProjectId: "p1", worktrees }
    );
    expect(item?.description).not.toMatch(/claude/i);
    // Location before model: the stronger identifier leads.
    expect(item?.description).toBe(`feature-a · Opus 4.8 · ${item?.timeAgo}`);
    expect(item?.modelName).toBe("Opus 4.8");
    expect(item?.location).toBe("feature-a");
    // Still findable by agent, though.
    expect(item?.searchAliases).toContain("Claude");
  });
});

describe("isAgentPlaceholderTitle", () => {
  const claude = { name: "Claude", command: "claude" };
  it("matches the agent's name, binary, and the Code / CLI spellings, case-insensitively", () => {
    expect(isAgentPlaceholderTitle("Claude Code", claude)).toBe(true);
    expect(isAgentPlaceholderTitle("claude code", claude)).toBe(true);
    expect(isAgentPlaceholderTitle("Claude CLI", claude)).toBe(true);
    expect(isAgentPlaceholderTitle("Claude", claude)).toBe(true);
  });
  it("keeps a task that merely mentions the product", () => {
    expect(isAgentPlaceholderTitle("Claude Code onboarding review", claude)).toBe(false);
    expect(isAgentPlaceholderTitle("Fix the auth bug", claude)).toBe(false);
    expect(isAgentPlaceholderTitle("Claude Code", undefined)).toBe(false);
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
    expect(prettifyModelId("anthropic/claude-opus-4-8")).toBe("Opus 4.8");
    expect(prettifyModelId("gpt-5.5")).toBe("GPT 5.5");
    expect(prettifyModelId("gpt-5.3-codex")).toBe("GPT 5.3 Codex");
    // A date stamp is not another version component.
    expect(prettifyModelId("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5 20250929");
    expect(prettifyModelId("gpt-4o")).toBe("GPT 4o");
  });
});

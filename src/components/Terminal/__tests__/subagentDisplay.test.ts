import { describe, expect, it } from "vitest";
import type { AgentSubagent, AgentSubagentStatus } from "@shared/types/ipc/agentSubagents";
import {
  subagentStatusLabel,
  subagentStatusTone,
  subagentSubtitle,
  subagentTitle,
  subagentUnavailableMessage,
} from "../subagentDisplay";

function subagent(overrides: Partial<AgentSubagent> = {}): AgentSubagent {
  return {
    id: "0199aa11-2233-4455-6677-8899aabbccdd",
    label: null,
    role: null,
    preview: "",
    model: null,
    depth: null,
    status: { type: "unknown", reason: "not-loaded" },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("subagentTitle", () => {
  it("prefers the provider's handle, then the role, then the task, then the id", () => {
    const full = subagent({ label: "Meitner", role: "reviewer", preview: "Review the diff" });
    expect(subagentTitle(full)).toBe("Meitner");
    expect(subagentTitle(subagent({ role: "reviewer", preview: "Review the diff" }))).toBe(
      "reviewer"
    );
    expect(subagentTitle(subagent({ preview: "Review the diff" }))).toBe("Review the diff");
    expect(subagentTitle(subagent())).toBe("0199aa11");
  });

  it("uses only the first line of a multi-line task and bounds its length", () => {
    const title = subagentTitle(
      subagent({ preview: `${"x".repeat(80)}\nsecond line that should never show` })
    );
    expect(title).toBe("x".repeat(48));
  });

  it("does not render whitespace-only metadata as a title", () => {
    expect(subagentTitle(subagent({ label: "   ", role: "\n\t", preview: "the task" }))).toBe(
      "the task"
    );
  });
});

describe("subagentSubtitle", () => {
  it("does not repeat whatever the title already shows", () => {
    expect(subagentSubtitle(subagent({ preview: "Review the diff" }))).toBeNull();
    expect(subagentSubtitle(subagent({ role: "reviewer" }))).toBeNull();
  });

  it("shows the task under a labelled child", () => {
    expect(subagentSubtitle(subagent({ label: "Meitner", preview: "Review the diff" }))).toBe(
      "Review the diff"
    );
  });

  it("has nothing to add when the provider recorded nothing but an id", () => {
    expect(subagentSubtitle(subagent())).toBeNull();
  });

  it("assembles the facts the title did not spend, in one line", () => {
    const line = subagentSubtitle(
      subagent({
        label: "Run the palette suite",
        preview: "Run the palette suite in the worktree",
        role: "General purpose",
        model: "haiku",
        depth: 2,
      })
    );
    expect(line).toBe("Run the palette suite in the worktree · General purpose · haiku · Depth 2");
  });

  it("leaves out a depth that every child shares", () => {
    expect(subagentSubtitle(subagent({ label: "Child", depth: 1 }))).toBeNull();
  });
});

describe("subagentStatusLabel", () => {
  it("reports the more urgent reason when a child is blocked", () => {
    expect(subagentStatusLabel({ type: "blocked", reason: "approval" })).toBe(
      "Waiting for approval"
    );
    expect(subagentStatusLabel({ type: "blocked", reason: "input" })).toBe("Waiting for input");
  });

  it("distinguishes a running child from a finished one and from a quiet one", () => {
    const labels = (["working", "completed", "idle", "error"] as const).map((type) =>
      subagentStatusLabel({ type } as AgentSubagentStatus)
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does not claim a child is idle when we never observed it", () => {
    expect(subagentStatusLabel({ type: "unknown", reason: "not-loaded" })).not.toBe(
      subagentStatusLabel({ type: "idle" })
    );
  });

  it("separates a child the provider never loaded from one that just went quiet", () => {
    expect(subagentStatusLabel({ type: "unknown", reason: "not-loaded" })).not.toBe(
      subagentStatusLabel({ type: "unknown", reason: "stale" })
    );
  });
});

describe("subagentStatusTone", () => {
  it("separates an error from a live child and from everything quiet", () => {
    expect(subagentStatusTone({ type: "error" })).toBe("error");
    expect(subagentStatusTone({ type: "working" })).toBe("active");
    expect(subagentStatusTone({ type: "blocked", reason: "approval" })).toBe("active");
    expect(subagentStatusTone({ type: "idle" })).toBe("muted");
    expect(subagentStatusTone({ type: "completed" })).toBe("muted");
    expect(subagentStatusTone({ type: "unknown", reason: "stale" })).toBe("muted");
  });
});

describe("subagentUnavailableMessage", () => {
  it("gives each reason its own explanation", () => {
    const reasons = [
      "provider-mismatch",
      "terminal-unknown",
      "no-session",
      "subagent-not-found",
      "cli-missing",
      "ambiguous-session",
      "timeout",
      "protocol-error",
      "store-unreadable",
    ] as const;
    const messages = reasons.map((reason) => subagentUnavailableMessage(reason, "Codex"));
    // `provider-mismatch` and `terminal-unknown` deliberately share one, since
    // neither tells the user anything more than "not this terminal".
    expect(new Set(messages).size).toBe(reasons.length - 1);
  });

  it("names the agent the message is actually about", () => {
    expect(subagentUnavailableMessage("cli-missing", "Claude")).toContain("Claude");
    expect(subagentUnavailableMessage("cli-missing", "Codex")).toContain("Codex");
  });
});

import { describe, expect, it } from "vitest";
import type { CodexSubagent, CodexSubagentStatus } from "@shared/types/ipc/codexSubagents";
import {
  codexUnavailableMessage,
  subagentStatusLabel,
  subagentStatusTone,
  subagentSubtitle,
  subagentTitle,
} from "../codexSubagentDisplay";

function subagent(overrides: Partial<CodexSubagent> = {}): CodexSubagent {
  return {
    threadId: "0199aa11-2233-4455-6677-8899aabbccdd",
    parentThreadId: "root",
    nickname: null,
    role: null,
    preview: "",
    cwd: "/repo",
    status: { type: "notLoaded" },
    createdAt: 0,
    updatedAt: 0,
    acceptsDirectInput: false,
    ...overrides,
  };
}

describe("subagentTitle", () => {
  it("prefers the nickname, then the role, then the task, then the id", () => {
    const full = subagent({ nickname: "Meitner", role: "reviewer", preview: "Review the diff" });
    expect(subagentTitle(full)).toBe("Meitner");
    expect(subagentTitle({ ...full, nickname: null })).toBe("reviewer");
    expect(subagentTitle({ ...full, nickname: null, role: null })).toBe("Review the diff");

    const bare = subagent();
    // Falls back to a fragment of the id rather than rendering an empty row.
    const fallback = subagentTitle(bare);
    expect(fallback).not.toBe("");
    expect(fallback.length).toBeLessThan(bare.threadId.length);
    expect(bare.threadId.startsWith(fallback)).toBe(true);
  });

  it("uses only the first line of a multi-line task and bounds its length", () => {
    const multiline = subagent({ preview: "Check the parser\nthen report back" });
    expect(subagentTitle(multiline)).toBe("Check the parser");

    const source = `START${"x".repeat(500)}`;
    const long = subagent({ preview: source });
    const title = subagentTitle(long);
    expect(title.length).toBeLessThan(source.length);
    expect(source.startsWith(title)).toBe(true);
  });

  it("does not render whitespace-only metadata as a title", () => {
    const blankName = subagent({ nickname: "   ", role: "\n", preview: "Review the diff" });
    expect(subagentTitle(blankName)).toBe("Review the diff");
  });
});

describe("subagentSubtitle", () => {
  it("does not repeat whatever the title already shows", () => {
    // With no nickname or role the title IS the task, so the subtitle must not
    // echo it back on the line underneath.
    const taskOnly = subagent({ preview: "Review the diff" });
    expect(subagentTitle(taskOnly)).toBe("Review the diff");
    expect(subagentSubtitle(taskOnly)).toBeNull();
  });

  it("shows the task under a nicknamed child", () => {
    const named = subagent({ nickname: "Kant", preview: "Run the tests" });
    expect(subagentSubtitle(named)).toBe("Run the tests");
  });

  it("falls back to the role when there is no task text", () => {
    expect(subagentSubtitle(subagent({ nickname: "Kant", role: "tester" }))).toBe("tester");
    expect(subagentSubtitle(subagent())).toBeNull();
  });

  it("never restates the title, whichever field the title came from", () => {
    // Every collision the fallback chain can produce: role doubling as the
    // task, and a nickname identical to the role.
    const roleIsTask = subagent({ role: "reviewer", preview: "reviewer" });
    expect(subagentSubtitle(roleIsTask)).not.toBe(subagentTitle(roleIsTask));

    const sameNameAndRole = subagent({ nickname: "reviewer", role: "reviewer" });
    expect(subagentSubtitle(sameNameAndRole)).not.toBe(subagentTitle(sameNameAndRole));
  });
});

describe("subagentStatusLabel", () => {
  it("reports the more urgent reason when a child is blocked on both", () => {
    const both: CodexSubagentStatus = {
      type: "active",
      activeFlags: ["waitingOnUserInput", "waitingOnApproval"],
    };
    const approvalOnly: CodexSubagentStatus = {
      type: "active",
      activeFlags: ["waitingOnApproval"],
    };
    const inputOnly: CodexSubagentStatus = {
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    };

    expect(subagentStatusLabel(both)).toBe(subagentStatusLabel(approvalOnly));
    expect(subagentStatusLabel(both)).not.toBe(subagentStatusLabel(inputOnly));
  });

  it("distinguishes an unflagged active child from an idle one", () => {
    const working = subagentStatusLabel({ type: "active", activeFlags: [] });
    expect(working).not.toBe(subagentStatusLabel({ type: "idle" }));
    expect(working).not.toBe(subagentStatusLabel({ type: "notLoaded" }));
  });

  it("does not claim a stored child is idle when we never observed it", () => {
    // Daintree reads persisted state, so notLoaded is the common case; calling
    // it "idle" would assert something we did not see.
    expect(subagentStatusLabel({ type: "notLoaded" })).not.toBe(
      subagentStatusLabel({ type: "idle" })
    );
  });
});

describe("subagentStatusTone", () => {
  it("separates an error from a live child and from everything quiet", () => {
    expect(subagentStatusTone({ type: "systemError" })).toBe("error");
    expect(subagentStatusTone({ type: "active", activeFlags: [] })).toBe("active");
    expect(subagentStatusTone({ type: "idle" })).toBe("muted");
    expect(subagentStatusTone({ type: "notLoaded" })).toBe("muted");
  });
});

describe("codexUnavailableMessage", () => {
  it("gives each reason its own explanation", () => {
    const reasons = [
      "cli-missing",
      "no-session",
      "ambiguous-session",
      "timeout",
      "protocol-error",
      "not-codex",
    ] as const;
    const messages = reasons.map(codexUnavailableMessage);
    // "not-codex" and "terminal-unknown" deliberately share wording; the rest
    // must not collapse into one another.
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) {
      expect(message.endsWith(".")).toBe(false);
    }
  });
});

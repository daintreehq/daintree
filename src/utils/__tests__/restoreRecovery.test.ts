import { describe, expect, it } from "vitest";
import {
  resolveConversationSearchCwd,
  sanitizeConversationCwd,
  sanitizeRestoreRecovery,
} from "../restoreRecovery";

describe("sanitizeRestoreRecovery (#12434)", () => {
  it("keeps a well-formed marker", () => {
    expect(
      sanitizeRestoreRecovery({
        reason: "destination-unavailable",
        sessionId: "sess-a",
        awaitingDestination: true,
      })
    ).toEqual({
      reason: "destination-unavailable",
      sessionId: "sess-a",
      awaitingDestination: true,
    });
  });

  it("drops anything that isn't a marker at all", () => {
    for (const value of [undefined, null, "held", 1, true, ["reason"]]) {
      expect(sanitizeRestoreRecovery(value)).toBeUndefined();
    }
  });

  it("still holds the pane when a newer build wrote a reason this one doesn't know", () => {
    expect(sanitizeRestoreRecovery({ reason: "from-the-future" })).toEqual({
      reason: "session-unresolved",
    });
    expect(sanitizeRestoreRecovery({})).toEqual({ reason: "session-unresolved" });
  });

  it("refuses a candidate id that could read as a flag or smuggle control characters", () => {
    expect(
      sanitizeRestoreRecovery({ reason: "destination-unavailable", sessionId: "--last" })
    ).toEqual({ reason: "destination-unavailable" });
    expect(
      sanitizeRestoreRecovery({ reason: "destination-unavailable", sessionId: "a\nb" })
    ).toEqual({ reason: "destination-unavailable" });
    expect(sanitizeRestoreRecovery({ reason: "destination-unavailable", sessionId: 7 })).toEqual({
      reason: "destination-unavailable",
    });
  });

  it("treats only a literal true as still awaiting a destination", () => {
    expect(
      sanitizeRestoreRecovery({ reason: "session-unresolved", awaitingDestination: "yes" })
    ).toEqual({ reason: "session-unresolved" });
  });
});

describe("sanitizeConversationCwd (#12434)", () => {
  it("accepts a path and rejects blanks, non-strings and control characters", () => {
    expect(sanitizeConversationCwd("/repo")).toBe("/repo");
    expect(sanitizeConversationCwd("   ")).toBeUndefined();
    expect(sanitizeConversationCwd(42)).toBeUndefined();
    expect(sanitizeConversationCwd("/repo")).toBeUndefined();
  });
});

describe("resolveConversationSearchCwd (#12434)", () => {
  it("searches where the conversation began, not where the pane runs", () => {
    expect(
      resolveConversationSearchCwd({ cwd: "/worktrees/task-a", conversationCwd: "/repo" })
    ).toBe("/repo");
    expect(resolveConversationSearchCwd({ cwd: "/repo" })).toBe("/repo");
  });
});

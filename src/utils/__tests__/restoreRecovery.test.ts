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

  it("keeps a marker the resume setting wrote, with its conversation (#13509)", () => {
    expect(sanitizeRestoreRecovery({ reason: "resume-deferred", sessionId: "sess-c" })).toEqual({
      reason: "resume-deferred",
      sessionId: "sess-c",
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

describe("sanitizeRestoreRecovery host end (#14382)", () => {
  it("keeps what the crash record observed", () => {
    expect(
      sanitizeRestoreRecovery({
        reason: "host-ended-uncleanly",
        sessionId: "sess-a",
        hostEnd: { cause: "watchdog-deadlock", at: 5_000, missedBeats: 3 },
      })
    ).toEqual({
      reason: "host-ended-uncleanly",
      sessionId: "sess-a",
      hostEnd: { cause: "watchdog-deadlock", at: 5_000, missedBeats: 3 },
    });
  });

  it.each(["external-kill", "unknown"])("keeps a %s record", (cause) => {
    expect(
      sanitizeRestoreRecovery({ reason: "host-ended-uncleanly", hostEnd: { cause, at: 5_000 } })
    ).toEqual({ reason: "host-ended-uncleanly", hostEnd: { cause, at: 5_000 } });
  });

  it("drops an unreadable record but keeps the hold", () => {
    for (const hostEnd of [
      { cause: "power-loss", at: 5_000 },
      { cause: "external-kill", at: -1 },
      { cause: "external-kill", at: Number.POSITIVE_INFINITY },
      { cause: "external-kill", at: "5000" },
      { cause: "external-kill" },
      "external-kill",
    ]) {
      expect(sanitizeRestoreRecovery({ reason: "host-ended-uncleanly", hostEnd })).toEqual({
        reason: "host-ended-uncleanly",
      });
    }
  });

  it.each([1.5, 0, -2, "3"])("drops a heartbeat count of %s but keeps the cause", (missedBeats) => {
    expect(
      sanitizeRestoreRecovery({
        reason: "host-ended-uncleanly",
        hostEnd: { cause: "watchdog-deadlock", at: 5_000, missedBeats },
      })?.hostEnd
    ).toEqual({ cause: "watchdog-deadlock", at: 5_000 });
  });

  it("quotes a host end only on its own hold", () => {
    expect(
      sanitizeRestoreRecovery({
        reason: "resume-deferred",
        hostEnd: { cause: "external-kill", at: 5_000 },
      })
    ).toEqual({ reason: "resume-deferred" });
  });
});

describe("sanitizeConversationCwd (#12434)", () => {
  it("accepts a path and rejects blanks, non-strings and control characters", () => {
    expect(sanitizeConversationCwd("/repo")).toBe("/repo");
    expect(sanitizeConversationCwd("   ")).toBeUndefined();
    expect(sanitizeConversationCwd(42)).toBeUndefined();
    expect(sanitizeConversationCwd("/repo\x07")).toBeUndefined();
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

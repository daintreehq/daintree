import { describe, it, expect } from "vitest";
import {
  newerObservation,
  readLastSeen,
  restoredField,
  sanitizeAgentObservation,
  sanitizeLiveRestoreProvenance,
  sanitizeRestoreProvenance,
  summarizeRestoreProvenance,
} from "../restoreProvenance.js";

describe("readLastSeen", () => {
  it("pairs a saved state with the time it began", () => {
    expect(readLastSeen("idle", 1_000)).toEqual({ agentState: "idle", at: 1_000 });
  });

  it("keeps the state when the time is unusable", () => {
    expect(readLastSeen("waiting", "soon")).toEqual({ agentState: "waiting" });
    expect(readLastSeen("waiting", Number.NaN)).toEqual({ agentState: "waiting" });
    expect(readLastSeen("waiting", 0)).toEqual({ agentState: "waiting" });
    expect(readLastSeen("waiting", -5)).toEqual({ agentState: "waiting" });
    // Past the latest instant a Date can hold.
    expect(readLastSeen("waiting", 1e100)).toEqual({ agentState: "waiting" });
  });

  it("reports nothing for an unknown state or the renderer-only directing overlay", () => {
    expect(readLastSeen("finished", 1_000)).toBeUndefined();
    expect(readLastSeen(undefined, 1_000)).toBeUndefined();
    expect(readLastSeen("directing", 1_000)).toBeUndefined();
  });
});

describe("sanitizeAgentObservation", () => {
  it("reads a saved observation and rejects anything else", () => {
    expect(sanitizeAgentObservation({ agentState: "idle", at: 1_000 })).toEqual({
      agentState: "idle",
      at: 1_000,
    });
    expect(sanitizeAgentObservation("idle")).toBeUndefined();
    expect(sanitizeAgentObservation({ agentState: "directing", at: 1_000 })).toBeUndefined();
  });
});

describe("sanitizeRestoreProvenance", () => {
  it("passes a well-formed record through", () => {
    const record = {
      at: 2_000,
      disposition: "held",
      lastSeen: { agentState: "idle", at: 1_000 },
    };
    expect(sanitizeRestoreProvenance(record)).toEqual(record);
  });

  it("drops a record nobody can place", () => {
    expect(sanitizeRestoreProvenance(undefined)).toBeUndefined();
    expect(sanitizeRestoreProvenance([])).toBeUndefined();
    expect(sanitizeRestoreProvenance({ disposition: "resume" })).toBeUndefined();
    expect(sanitizeRestoreProvenance({ at: 2_000, disposition: "finished" })).toBeUndefined();
  });

  it("drops a record whose time no Date can hold", () => {
    expect(sanitizeRestoreProvenance({ at: 1e100, disposition: "resume" })).toBeUndefined();
    expect(sanitizeRestoreProvenance({ at: -1, disposition: "resume" })).toBeUndefined();
  });

  it("drops only a malformed last-seen observation", () => {
    expect(
      sanitizeRestoreProvenance({
        at: 2_000,
        disposition: "resume",
        lastSeen: { agentState: "bogus" },
        extra: "ignored",
      })
    ).toEqual({ at: 2_000, disposition: "resume" });
  });
});

describe("summarizeRestoreProvenance", () => {
  const restoreProvenance = {
    at: 2_000,
    disposition: "resume",
    lastSeen: { agentState: "idle", at: 1_000 },
  };

  it("is absent for a pane restore never rebuilt", () => {
    expect(summarizeRestoreProvenance({})).toBeUndefined();
    expect(restoredField({})).toEqual({});
  });

  it("reports the recorded disposition and last state seen", () => {
    expect(restoredField({ restoreProvenance })).toEqual({
      restored: { at: 2_000, disposition: "resume", lastSeen: { agentState: "idle", at: 1_000 } },
    });
  });

  it("reports a pane held right now as held, with the hold's reason", () => {
    expect(
      summarizeRestoreProvenance({
        restoreProvenance,
        restoreRecovery: { reason: "held-by-plugin", sessionId: "sess-c" },
      })
    ).toEqual({
      at: 2_000,
      disposition: "held",
      heldReason: "held-by-plugin",
      lastSeen: { agentState: "idle", at: 1_000 },
    });
  });

  it("never exposes the conversation a hold keeps", () => {
    const summary = summarizeRestoreProvenance({
      restoreProvenance,
      restoreRecovery: { reason: "resume-deferred", sessionId: "sess-c" },
    });
    expect(JSON.stringify(summary)).not.toContain("sess-c");
  });
});

describe("sanitizeLiveRestoreProvenance", () => {
  it("keeps a resume or fresh record for a running pane", () => {
    expect(sanitizeLiveRestoreProvenance({ at: 2_000, disposition: "fresh" })).toEqual({
      at: 2_000,
      disposition: "fresh",
    });
  });

  it("drops a held record, which a running process contradicts", () => {
    expect(sanitizeLiveRestoreProvenance({ at: 2_000, disposition: "held" })).toBeUndefined();
  });
});

describe("newerObservation", () => {
  const idle = { agentState: "idle" as const, at: 8_000 };
  const working = { agentState: "working" as const, at: 6_000 };

  it("keeps the observation whose state began later, whichever side it is on", () => {
    expect(newerObservation(working, idle)).toBe(idle);
    expect(newerObservation(idle, working)).toBe(idle);
  });

  it("takes whichever exists, and the first on a tie or with no times", () => {
    expect(newerObservation(undefined, idle)).toBe(idle);
    expect(newerObservation(idle, undefined)).toBe(idle);
    expect(newerObservation({ agentState: "waiting" }, { agentState: "idle" })).toEqual({
      agentState: "waiting",
    });
  });
});

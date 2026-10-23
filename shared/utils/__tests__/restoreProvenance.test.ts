import { describe, it, expect } from "vitest";
import {
  readLastSeen,
  restoredField,
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
  });

  it("reports nothing for an unknown state or the renderer-only directing overlay", () => {
    expect(readLastSeen("finished", 1_000)).toBeUndefined();
    expect(readLastSeen(undefined, 1_000)).toBeUndefined();
    expect(readLastSeen("directing", 1_000)).toBeUndefined();
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

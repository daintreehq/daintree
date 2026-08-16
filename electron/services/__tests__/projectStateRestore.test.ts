import { describe, it, expect } from "vitest";

import {
  countResumableAgentPanels,
  filterRestorableTerminalSnapshots,
} from "../projectStateRestore.js";

/**
 * A snapshot shaped like the ones `state.json` actually holds. Only the fields
 * the predicate reads are varied per case; the rest is the minimum
 * `TerminalSnapshotSchema` accepts.
 */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    title: "Terminal",
    kind: "terminal",
    cwd: "/repo",
    location: "grid",
    ...overrides,
  };
}

const CONTEXT = "projectStateRestore.test";

describe("filterRestorableTerminalSnapshots", () => {
  it("keeps the panels a project would come back with", () => {
    const kept = filterRestorableTerminalSnapshots(
      [snapshot({ id: "a" }), snapshot({ id: "b", location: "dock" })],
      CONTEXT
    );
    expect(kept.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("drops trashed panels, which restore is going to drop anyway", () => {
    const kept = filterRestorableTerminalSnapshots(
      [snapshot({ id: "live" }), snapshot({ id: "binned", location: "trash" })],
      CONTEXT
    );
    expect(kept.map((t) => t.id)).toEqual(["live"]);
  });

  it("drops entries the snapshot schema refuses", () => {
    // A PTY-backed kind with no cwd is the schema's own refusal, and the count
    // has to inherit it rather than promise a panel restore cannot rebuild.
    const kept = filterRestorableTerminalSnapshots(
      [snapshot({ id: "ok" }), snapshot({ id: "no-cwd", cwd: undefined })],
      CONTEXT
    );
    expect(kept.map((t) => t.id)).toEqual(["ok"]);
  });

  it("treats a missing terminals array as nothing to restore", () => {
    expect(filterRestorableTerminalSnapshots(undefined, CONTEXT)).toEqual([]);
  });
});

describe("countResumableAgentPanels", () => {
  it("counts only the panels that carry an agent to resume", () => {
    const count = countResumableAgentPanels(
      [
        snapshot({ id: "agent-1", launchAgentId: "claude" }),
        snapshot({ id: "agent-2", launchAgentId: "codex" }),
        snapshot({ id: "plain-shell" }),
      ],
      CONTEXT
    );
    expect(count).toBe(2);
  });

  it("is zero when a project holds panels but none of them launch an agent", () => {
    // Distinct from "no panels at all": both restore no agents, and the row
    // must read the same either way.
    const count = countResumableAgentPanels([snapshot(), snapshot({ id: "t2" })], CONTEXT);
    expect(count).toBe(0);
  });

  it("does not count an agent panel sitting in the trash", () => {
    const count = countResumableAgentPanels(
      [
        snapshot({ id: "kept", launchAgentId: "claude" }),
        snapshot({ id: "binned", launchAgentId: "claude", location: "trash" }),
      ],
      CONTEXT
    );
    expect(count).toBe(1);
  });

  it("counts an agent panel whose session has already ended", () => {
    // The resume command is built from the persisted snapshot, not from a live
    // process — so a panel whose agent exited still comes back, and still
    // counts. Two panels differing only in whether a session id survived must
    // therefore agree.
    const withSession = countResumableAgentPanels(
      [snapshot({ launchAgentId: "claude", agentSessionId: "sess-1" })],
      CONTEXT
    );
    const withoutSession = countResumableAgentPanels(
      [snapshot({ launchAgentId: "claude" })],
      CONTEXT
    );
    expect(withoutSession).toBe(withSession);
  });

  it("agrees with the restorable set it is derived from", () => {
    // The count must never exceed what actually restores; that gap is the bug
    // the shared helper exists to prevent.
    const terminals = [
      snapshot({ id: "a", launchAgentId: "claude" }),
      snapshot({ id: "b" }),
      snapshot({ id: "c", launchAgentId: "codex", location: "trash" }),
      snapshot({ id: "d", cwd: undefined, launchAgentId: "claude" }),
    ];
    const restorable = filterRestorableTerminalSnapshots(terminals, CONTEXT);
    expect(countResumableAgentPanels(terminals, CONTEXT)).toBeLessThanOrEqual(restorable.length);
  });
});

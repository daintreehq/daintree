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
    // counts. Both spellings must land on 1; asserting only that they agree
    // would also pass if the helper had stopped counting either.
    expect(
      countResumableAgentPanels(
        [snapshot({ launchAgentId: "claude", agentSessionId: "sess-1" })],
        CONTEXT
      )
    ).toBe(1);
    expect(countResumableAgentPanels([snapshot({ launchAgentId: "claude" })], CONTEXT)).toBe(1);
  });

  it("does not count a legacy assistant panel, which restore drops outright", () => {
    // The schema permits `launchAgentId` on every kind, but `panelRestorePhase`
    // skips assistant snapshots by name — counting one announces an agent that
    // never arrives.
    const count = countResumableAgentPanels(
      [snapshot({ id: "assistant", kind: "assistant", cwd: undefined, launchAgentId: "claude" })],
      CONTEXT
    );
    expect(count).toBe(0);
  });

  it("does not count non-PTY panels carrying stale launch metadata", () => {
    // A browser or dev-preview panel restores as itself, not as a running
    // agent, however its snapshot happens to be labelled.
    const count = countResumableAgentPanels(
      [
        snapshot({
          id: "browser",
          kind: "browser",
          cwd: undefined,
          browserUrl: "https://example.com",
          launchAgentId: "claude",
        }),
        snapshot({
          id: "preview",
          kind: "dev-preview",
          devCommand: "npm run dev",
          launchAgentId: "codex",
        }),
      ],
      CONTEXT
    );
    expect(count).toBe(0);
  });

  it("resolves kind the way restore does, not by reading the field", () => {
    // A snapshot with no `kind` is classified by the same inference restore
    // uses. With a cwd it is a terminal and counts; the mislabelled legacy
    // "agent" spelling collapses to terminal and counts too.
    const count = countResumableAgentPanels(
      [
        snapshot({ id: "inferred", kind: undefined, launchAgentId: "claude" }),
        snapshot({ id: "legacy", kind: "agent", launchAgentId: "claude" }),
      ],
      CONTEXT
    );
    expect(count).toBe(2);
  });

  it("never promises more panels than the restorable set contains", () => {
    // The count is a claim the switcher makes out loud, so the exact figure
    // matters: of these four, only "a" is a restorable agent panel.
    const terminals = [
      snapshot({ id: "a", launchAgentId: "claude" }),
      snapshot({ id: "b" }),
      snapshot({ id: "c", launchAgentId: "codex", location: "trash" }),
      snapshot({ id: "d", cwd: undefined, launchAgentId: "claude" }),
    ];
    const restorable = filterRestorableTerminalSnapshots(terminals, CONTEXT);
    expect(countResumableAgentPanels(terminals, CONTEXT)).toBe(1);
    expect(restorable.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

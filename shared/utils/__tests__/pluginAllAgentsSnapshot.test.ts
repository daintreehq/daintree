import { describe, expect, it } from "vitest";
import {
  normalizePluginAllAgentsSnapshot,
  toPluginAllAgentsSnapshot,
  UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT,
} from "../pluginAllAgentsSnapshot.js";
import type { FleetRunRow } from "../../types/ipc/fleet.js";

const PROJECT_ID = "b".repeat(64);
const SCRATCH_ID = "12345678-1234-4abc-8def-123456789abc";

const FULL_ROW: FleetRunRow = {
  runId: "t-1",
  workspaceId: PROJECT_ID,
  worktreeId: "wt-1",
  agentId: "claude",
  agentState: "waiting",
  waitingReason: "prompt",
  since: 3,
  spawnedAt: 1,
  title: "Fix auth",
  lastObservedTitle: "raw osc title",
  titleMode: "user",
  cwd: "/home/me/secret",
  launchAgentId: "claude",
  everDetectedAgent: true,
  agentPresetColor: "#fff",
  park: { parkedAt: 4, note: "private note" },
  snooze: { snoozedAt: 5, snoozedUntil: 6 },
  quietSince: 2,
};

describe("toPluginAllAgentsSnapshot", () => {
  it("exposes exactly the allowlist and nothing else from a fleet row", () => {
    const result = toPluginAllAgentsSnapshot({
      runs: [FULL_ROW],
      changedAt: 10,
      degraded: false,
      lastSuccessfulAt: 11,
    });

    expect(Object.keys(result).sort()).toEqual(["agents", "degraded", "lastSuccessfulAt"]);
    expect(Object.keys(result.agents[0]!).sort()).toEqual([
      "agentId",
      "observedState",
      "terminalId",
      "title",
      "workspaceId",
      "workspaceKind",
      "worktreeId",
    ]);
    expect(result.agents[0]).toEqual({
      workspaceId: PROJECT_ID,
      workspaceKind: "project",
      terminalId: "t-1",
      worktreeId: "wt-1",
      title: "Fix auth",
      agentId: "claude",
      observedState: "waiting",
    });
    expect(result.lastSuccessfulAt).toBe(11);
  });

  it("omits absent optional fields rather than carrying undefined keys", () => {
    const result = toPluginAllAgentsSnapshot({
      runs: [{ runId: "t-2", workspaceId: SCRATCH_ID, spawnedAt: 1, cwd: "/x" }],
      changedAt: 1,
      degraded: false,
      lastSuccessfulAt: 1,
    });

    expect(result.agents[0]).toEqual({
      workspaceId: SCRATCH_ID,
      workspaceKind: "scratch",
      terminalId: "t-2",
    });
    expect(Object.keys(result.agents[0]!)).toHaveLength(3);
  });

  it("freezes the wrapper, the list and every entry", () => {
    const result = toPluginAllAgentsSnapshot({
      runs: [FULL_ROW],
      changedAt: 1,
      degraded: false,
      lastSuccessfulAt: 1,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.agents)).toBe(true);
    expect(Object.isFrozen(result.agents[0])).toBe(true);
  });

  it("carries degraded retained runs through as stale", () => {
    const result = toPluginAllAgentsSnapshot({
      runs: [FULL_ROW],
      changedAt: 1,
      degraded: true,
      lastSuccessfulAt: 8,
    });

    expect(result.degraded).toBe(true);
    expect(result.lastSuccessfulAt).toBe(8);
    expect(result.agents).toHaveLength(1);
  });

  it("reads a missing snapshot as unavailable, not as an empty fleet", () => {
    expect(toPluginAllAgentsSnapshot(null)).toBe(UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT);
    expect(UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT).toEqual({
      agents: [],
      degraded: true,
      lastSuccessfulAt: null,
    });
    expect(Object.isFrozen(UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT.agents)).toBe(true);
  });
});

describe("normalizePluginAllAgentsSnapshot", () => {
  it("re-applies the allowlist and freeze to a cloned snapshot", () => {
    const result = normalizePluginAllAgentsSnapshot({
      agents: [
        {
          workspaceId: PROJECT_ID,
          workspaceKind: "scratch",
          terminalId: "t-1",
          observedState: "working",
          cwd: "/leak",
        },
      ],
      degraded: false,
      lastSuccessfulAt: 3,
      extra: true,
    });

    expect(result).toEqual({
      agents: [
        {
          workspaceId: PROJECT_ID,
          // Derived from the id again, never trusted from the input.
          workspaceKind: "project",
          terminalId: "t-1",
          observedState: "working",
        },
      ],
      degraded: false,
      lastSuccessfulAt: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.agents[0])).toBe(true);
  });

  it("drops malformed entries and reads malformed input as unavailable", () => {
    expect(normalizePluginAllAgentsSnapshot(undefined)).toBe(
      UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT
    );
    expect(normalizePluginAllAgentsSnapshot({ agents: "nope" })).toBe(
      UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT
    );
    const result = normalizePluginAllAgentsSnapshot({
      agents: [null, { terminalId: "t-1" }, { workspaceId: PROJECT_ID, terminalId: "t-2" }],
      degraded: false,
      lastSuccessfulAt: "soon",
    });
    expect(result.agents.map((a) => a.terminalId)).toEqual(["t-2"]);
    expect(result.lastSuccessfulAt).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPluginLaunchesForTests,
  admitRestoredPluginLaunches,
  attachPluginLaunchPersistence,
  detachPluginLaunchPersistence,
  forgetPluginLaunches,
  forgetPluginLaunchesWhere,
  launchedAgentProject,
  MAX_STORED_PLUGIN_LAUNCHES,
  recordPluginLaunch,
  STORED_PLUGIN_LAUNCH_TTL_MS,
  type PluginLaunchPersistence,
  type StoredPluginLaunch,
} from "../pluginLaunchedAgents.js";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";

const PLUGIN = "acme.orchestrator";
const OTHER = "acme.other";
const NOW = 1_800_000_000_000;

/** The terminals main tracks, by id, and the project each runs in. */
let tracked: Map<string, string>;
const pty = { getTerminalProjectId: (id: string) => tracked.get(id) ?? null };

/** What a run leaves on disk; survives the "restarts" below. */
let disk: Record<string, StoredPluginLaunch> | undefined;
let saves: number;
const persistence: PluginLaunchPersistence = {
  load: () => disk,
  save: (records) => {
    saves += 1;
    disk = structuredClone(records);
  },
};

function launched(terminalId: string): ActionDispatchResult {
  return { ok: true, result: { launched: true, terminalId } };
}

function launch(terminalId: string, pluginId = PLUGIN, projectId: string | null = null): void {
  recordPluginLaunch(
    pluginId,
    "agent.launch",
    { agentId: "claude" },
    launched(terminalId),
    projectId
  );
}

/** Quit and start again: memory goes, the disk stays, and nothing runs until restore. */
function restart(): void {
  _resetPluginLaunchesForTests();
  tracked = new Map();
  attachPluginLaunchPersistence(persistence);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  _resetPluginLaunchesForTests();
  tracked = new Map();
  disk = undefined;
  saves = 0;
  attachPluginLaunchPersistence(persistence);
});

afterEach(() => {
  _resetPluginLaunchesForTests();
  vi.useRealTimers();
});

describe("plugin launch ledger across an app restart (#16240)", () => {
  it("brings a launch back once restore hands its pane back under the saved id", () => {
    launch("t-1");
    expect(disk).toEqual({ "t-1": { pluginId: PLUGIN, projectId: null, seenAt: NOW } });

    restart();
    // The pane runs again under its id, but restore hasn't handed it back.
    tracked.set("t-1", "p1");
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();

    vi.setSystemTime(NOW + 1000);
    admitRestoredPluginLaunches([{ id: "t-1", launchedByPluginId: PLUGIN }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBe("p1");
    expect(launchedAgentProject(pty, OTHER, "t-1", null)).toBeNull();
    expect(disk?.["t-1"]?.seenAt).toBe(NOW + 1000);
  });

  it("gives a pane restored under a fresh id nothing, and leaves the record with the old id", () => {
    launch("t-1");
    restart();
    tracked.set("t-fresh", "p1");
    tracked.set("t-1", "p1");
    admitRestoredPluginLaunches([{ id: "t-fresh", launchedByPluginId: PLUGIN }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-fresh", null)).toBeNull();
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
    expect(Object.keys(disk ?? {})).toEqual(["t-1"]);
  });

  it("drops the record when the saved pane under its id names another plugin, or none", () => {
    launch("t-1");
    launch("t-2");
    restart();
    tracked.set("t-1", "p1");
    tracked.set("t-2", "p1");
    admitRestoredPluginLaunches([{ id: "t-1", launchedByPluginId: OTHER }, { id: "t-2" }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
    expect(launchedAgentProject(pty, OTHER, "t-1", null)).toBeNull();
    expect(launchedAgentProject(pty, PLUGIN, "t-2", null)).toBeNull();
    expect(disk).toEqual({});
  });

  it("grants nothing from a saved pane's launching plugin alone", () => {
    restart();
    tracked.set("t-1", "p1");
    admitRestoredPluginLaunches([{ id: "t-1", launchedByPluginId: PLUGIN }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
    expect(saves).toBe(0);
  });

  it("keeps the launch's project, so a pane now elsewhere stays out of reach", () => {
    launch("t-1", PLUGIN, "p1");
    restart();
    tracked.set("t-1", "p2");
    admitRestoredPluginLaunches([{ id: "t-1", launchedByPluginId: PLUGIN }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
    tracked.set("t-1", "p1");
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBe("p1");
  });

  it("forgets on disk, including records restore hasn't handed back yet", () => {
    launch("t-1");
    launch("t-other", OTHER);
    restart();
    forgetPluginLaunches(PLUGIN);
    expect(Object.keys(disk ?? {})).toEqual(["t-other"]);

    restart();
    tracked.set("t-1", "p1");
    admitRestoredPluginLaunches([{ id: "t-1", launchedByPluginId: PLUGIN }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
  });

  it("leaves the disk alone once detached, as the service's teardown does", () => {
    launch("t-1");
    tracked.set("t-1", "p1");
    detachPluginLaunchPersistence();
    forgetPluginLaunchesWhere(() => true);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
    expect(Object.keys(disk ?? {})).toEqual(["t-1"]);
  });

  it("keeps a launch in memory only when nothing is attached", () => {
    detachPluginLaunchPersistence();
    launch("t-1");
    tracked.set("t-1", "p1");
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBe("p1");
    expect(disk).toBeUndefined();
  });

  it("loads the disk once, whichever caller attaches first", () => {
    launch("t-1");
    const second = { load: vi.fn(() => ({})), save: vi.fn() };
    attachPluginLaunchPersistence(second);
    expect(second.load).not.toHaveBeenCalled();
    launch("t-2");
    expect(second.save).not.toHaveBeenCalled();
    expect(Object.keys(disk ?? {}).sort()).toEqual(["t-1", "t-2"]);
  });

  it("drops malformed, expired and future records on load, and saves the pruned set", () => {
    _resetPluginLaunchesForTests();
    disk = {
      good: { pluginId: PLUGIN, projectId: "p1", seenAt: NOW - 1000 },
      expired: { pluginId: PLUGIN, projectId: null, seenAt: NOW - STORED_PLUGIN_LAUNCH_TTL_MS - 1 },
      future: { pluginId: PLUGIN, projectId: null, seenAt: NOW + 10 * 60_000 },
      noPlugin: { pluginId: "", projectId: null, seenAt: NOW },
      badProject: { pluginId: PLUGIN, projectId: 7, seenAt: NOW },
      noTime: { pluginId: PLUGIN, projectId: null },
      notAnObject: "acme.orchestrator",
    } as unknown as Record<string, StoredPluginLaunch>;
    attachPluginLaunchPersistence(persistence);
    expect(Object.keys(disk ?? {})).toEqual(["good"]);
  });

  it("treats an unreadable ledger as empty", () => {
    _resetPluginLaunchesForTests();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    attachPluginLaunchPersistence({
      load: () => {
        throw new Error("corrupt");
      },
      save: persistence.save,
    });
    launch("t-1");
    expect(Object.keys(disk ?? {})).toEqual(["t-1"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps the newest records past the cap", () => {
    for (let i = 0; i <= MAX_STORED_PLUGIN_LAUNCHES; i += 1) {
      vi.setSystemTime(NOW + i);
      launch(`t-${i}`);
    }
    expect(Object.keys(disk ?? {})).toHaveLength(MAX_STORED_PLUGIN_LAUNCHES);
    expect(disk?.["t-0"]).toBeUndefined();
    expect(disk?.[`t-${MAX_STORED_PLUGIN_LAUNCHES}`]).toBeDefined();
  });
});

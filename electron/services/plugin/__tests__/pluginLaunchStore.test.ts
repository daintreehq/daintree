import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});
vi.mock("../../../store.js", () => ({ store: storeMock }));

import {
  admitRestoredPluginLaunchesFromStore,
  storePluginLaunchPersistence,
} from "../pluginLaunchStore.js";
import {
  _resetPluginLaunchesForTests,
  attachPluginLaunchPersistence,
  launchedAgentProject,
  recordPluginLaunch,
} from "../pluginLaunchedAgents.js";

const PLUGIN = "acme.orchestrator";
const pty = { getTerminalProjectId: (id: string) => (id.startsWith("t-") ? "p1" : null) };
const stored = () =>
  storeMock._state.get("pluginLaunchedAgents") as
    Record<string, { pluginId: string; seenAt: number }> | undefined;

beforeEach(() => {
  _resetPluginLaunchesForTests();
  storeMock._state.clear();
  storeMock._state.set("pluginLaunchedAgents", {
    "t-1": { pluginId: PLUGIN, projectId: null, seenAt: Date.now() - 60_000 },
  });
});

afterEach(() => {
  _resetPluginLaunchesForTests();
});

describe("the plugin launch ledger's store (#16240)", () => {
  it("loads the ledger itself when a hydrate comes before the plugin host starts", () => {
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBeNull();
    const before = stored()?.["t-1"]?.seenAt ?? 0;

    admitRestoredPluginLaunchesFromStore([{ id: "t-1", launchedByPluginId: PLUGIN }]);
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBe("p1");
    expect(stored()?.["t-1"]?.seenAt).toBeGreaterThan(before);

    recordPluginLaunch(
      PLUGIN,
      "agent.launch",
      { agentId: "claude" },
      { ok: true, result: { launched: true, terminalId: "t-2" } },
      null
    );
    expect(Object.keys(stored() ?? {}).sort()).toEqual(["t-1", "t-2"]);
  });

  it("joins the ledger the plugin host already attached", () => {
    attachPluginLaunchPersistence(storePluginLaunchPersistence);
    storeMock.get.mockClear();
    admitRestoredPluginLaunchesFromStore([{ id: "t-1", launchedByPluginId: PLUGIN }]);
    expect(storeMock.get).not.toHaveBeenCalled();
    expect(launchedAgentProject(pty, PLUGIN, "t-1", null)).toBe("p1");
  });
});

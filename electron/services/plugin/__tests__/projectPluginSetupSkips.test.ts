import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import {
  getProjectPluginSetupSkips,
  setProjectPluginSetupStepSkipped,
} from "../projectPluginSetupSkips.js";

const STEPS = ["connect", "workspace", "sync"];

describe("projectPluginSetupSkips (#13824)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("keeps a skip to its project and plugin", () => {
    expect(setProjectPluginSetupStepSkipped("p1", "acme.tracker", "sync", true, STEPS)).toBe(true);
    expect(getProjectPluginSetupSkips("p1", "acme.tracker")).toEqual(["sync"]);
    expect(getProjectPluginSetupSkips("p2", "acme.tracker")).toEqual([]);
    expect(getProjectPluginSetupSkips("p1", "other.plugin")).toEqual([]);
  });

  it("restores a step and drops an emptied plugin and project", () => {
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "sync", true, STEPS);
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "connect", true, STEPS);
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "sync", false, STEPS);
    expect(getProjectPluginSetupSkips("p1", "acme.tracker")).toEqual(["connect"]);
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "connect", false, STEPS);
    expect(storeMock.data.get("projectPluginSetupSkips")).toEqual({});
  });

  it("writes nothing when the step is already as asked", () => {
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "sync", true, STEPS);
    storeMock.set.mockClear();
    expect(setProjectPluginSetupStepSkipped("p1", "acme.tracker", "sync", true, STEPS)).toBe(false);
    expect(setProjectPluginSetupStepSkipped("p1", "acme.tracker", "connect", false, STEPS)).toBe(
      false
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("drops skips for steps the plugin no longer declares on the next write", () => {
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "old-step", true, ["old-step"]);
    setProjectPluginSetupStepSkipped("p1", "acme.tracker", "sync", true, STEPS);
    expect(getProjectPluginSetupSkips("p1", "acme.tracker")).toEqual(["sync"]);
  });

  it("skips malformed entries in a hand-edited store and refuses malformed ids", () => {
    storeMock.data.set("projectPluginSetupSkips", {
      p1: { "acme.tracker": ["sync", 7, "", "sync", "x".repeat(65)] },
      p2: "not an object",
    });
    expect(getProjectPluginSetupSkips("p1", "acme.tracker")).toEqual(["sync"]);
    expect(getProjectPluginSetupSkips("p2", "acme.tracker")).toEqual([]);
    expect(() => setProjectPluginSetupStepSkipped("p1", "acme.tracker", "", true, STEPS)).toThrow();
    expect(() => setProjectPluginSetupStepSkipped("p1", "", "sync", true, STEPS)).toThrow();
  });
});

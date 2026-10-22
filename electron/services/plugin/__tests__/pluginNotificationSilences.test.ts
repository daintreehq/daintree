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
  getPluginNotificationSilences,
  isPluginNotificationSilenced,
  setPluginNotificationSilenced,
} from "../pluginNotificationSilences.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE_A = `project__${PROJECT_A}__acme.records`;
const INSTANCE_B = `project__${PROJECT_B}__acme.records`;

describe("pluginNotificationSilences (#13818)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("silences a project plugin in its own project and nowhere else", () => {
    expect(setPluginNotificationSilenced(INSTANCE_A, true)).toEqual([INSTANCE_A]);
    expect(isPluginNotificationSilenced(INSTANCE_A)).toBe(true);
    expect(isPluginNotificationSilenced(INSTANCE_B)).toBe(false);
    // An installed plugin of the same name is a different instance.
    expect(isPluginNotificationSilenced("acme.records")).toBe(false);
  });

  it("silences an installed plugin without touching a project's copy", () => {
    setPluginNotificationSilenced("acme.records", true);
    expect(isPluginNotificationSilenced("acme.records")).toBe(true);
    expect(isPluginNotificationSilenced(INSTANCE_A)).toBe(false);
  });

  it("lifts a silence and writes nothing when already as asked", () => {
    setPluginNotificationSilenced("acme.records", true);
    setPluginNotificationSilenced(INSTANCE_A, true);
    storeMock.set.mockClear();
    expect(setPluginNotificationSilenced("acme.records", true)).toEqual([
      "acme.records",
      INSTANCE_A,
    ]);
    expect(setPluginNotificationSilenced("never.silenced", false)).toHaveLength(2);
    expect(storeMock.set).not.toHaveBeenCalled();

    expect(setPluginNotificationSilenced("acme.records", false)).toEqual([INSTANCE_A]);
    expect(storeMock.data.get("pluginNotificationSilences")).toEqual([INSTANCE_A]);
  });

  it("refuses a silence past the cap rather than leaving the plugin audible quietly", () => {
    storeMock.data.set(
      "pluginNotificationSilences",
      Array.from({ length: 500 }, (_, i) => `plugin.n${i}`)
    );
    expect(() => setPluginNotificationSilenced("one.more", true)).toThrow();
    expect(isPluginNotificationSilenced("one.more")).toBe(false);
    expect(setPluginNotificationSilenced("plugin.n0", false)).toHaveLength(499);
  });

  it("skips malformed entries in a hand-edited store", () => {
    storeMock.data.set("pluginNotificationSilences", [
      "acme.records",
      "../../etc/passwd",
      42,
      "project__not-a-project__acme.records",
      "acme.records",
    ]);
    expect(getPluginNotificationSilences()).toEqual(["acme.records"]);

    storeMock.data.set("pluginNotificationSilences", { "acme.records": true });
    expect(getPluginNotificationSilences()).toEqual([]);
  });
});

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

import { parsePluginAccountBinding, pluginAccountBindings } from "../pluginAccountBindings.js";

const KEY = "projectPluginAccountBindings";

describe("pluginAccountBindings (#14102)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("keeps a binding to its project and plugin", () => {
    expect(
      pluginAccountBindings.set("p1", "acme.tracker", { connectionId: "work", source: "own" })
    ).toBe(true);
    expect(pluginAccountBindings.get("p1", "acme.tracker")).toEqual({
      connectionId: "work",
      source: "own",
    });
    expect(pluginAccountBindings.get("p2", "acme.tracker")).toBeNull();
    expect(pluginAccountBindings.get("p1", "acme.other")).toBeNull();
  });

  it("writes nothing when the binding doesn't change", () => {
    pluginAccountBindings.set("p1", "acme.tracker", { connectionId: "work", source: "own" });
    storeMock.set.mockClear();
    expect(
      pluginAccountBindings.set("p1", "acme.tracker", { connectionId: "work", source: "own" })
    ).toBe(false);
    expect(pluginAccountBindings.set("p1", "acme.other", null)).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("forgets a binding and prunes the emptied project", () => {
    pluginAccountBindings.set("p1", "acme.tracker", { connectionId: "work", source: "machine" });
    expect(pluginAccountBindings.set("p1", "acme.tracker", null)).toBe(true);
    expect(storeMock.data.get(KEY)).toEqual({});
  });

  it("reads a hand-edited or malformed entry as no binding", () => {
    storeMock.data.set(KEY, {
      p1: {
        "acme.a": { connectionId: "Work!", source: "own" },
        "acme.b": { connectionId: "work", source: "somewhere" },
        "acme.c": "work",
      },
      p2: [],
    });
    expect(pluginAccountBindings.get("p1", "acme.a")).toBeNull();
    expect(pluginAccountBindings.get("p1", "acme.b")).toBeNull();
    expect(pluginAccountBindings.get("p1", "acme.c")).toBeNull();
    expect(pluginAccountBindings.get("p2", "acme.a")).toBeNull();
    expect(pluginAccountBindings.get("p1", "__proto__")).toBeNull();
  });

  it("refuses a malformed binding or key on write", () => {
    expect(() =>
      pluginAccountBindings.set("p1", "acme.tracker", {
        connectionId: "../x",
        source: "own",
      })
    ).toThrow(/malformed binding/);
    expect(() => pluginAccountBindings.set("", "acme.tracker", null)).toThrow(/project id/);
    expect(parsePluginAccountBinding({ connectionId: "work", source: "own", extra: 1 })).toEqual({
      connectionId: "work",
      source: "own",
    });
  });
});

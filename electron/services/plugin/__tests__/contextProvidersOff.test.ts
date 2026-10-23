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

import { getContextProvidersOff, setContextProvidersEnabled } from "../contextProvidersOff.js";

describe("contextProvidersOff (#13795)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("switches a plugin's providers off and back on", () => {
    setContextProvidersEnabled("acme.kanban", false);
    setContextProvidersEnabled("project__p1__acme.notes", false);
    expect([...getContextProvidersOff()]).toEqual(["acme.kanban", "project__p1__acme.notes"]);
    setContextProvidersEnabled("acme.kanban", true);
    expect([...getContextProvidersOff()]).toEqual(["project__p1__acme.notes"]);
  });

  it("writes nothing when the switch is already where it was asked to be", () => {
    setContextProvidersEnabled("acme.kanban", true);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("reads a hand-edited file defensively", () => {
    storeMock.data.set("pluginContextProvidersOff", ["ok", 7, "", "ok", "x".repeat(301)]);
    expect([...getContextProvidersOff()]).toEqual(["ok"]);
    storeMock.data.set("pluginContextProvidersOff", { not: "a list" });
    expect(getContextProvidersOff().size).toBe(0);
  });
});

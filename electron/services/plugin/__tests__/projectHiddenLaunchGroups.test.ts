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
  getProjectHiddenLaunchGroups,
  setProjectLaunchGroupHidden,
} from "../projectHiddenLaunchGroups.js";

describe("projectHiddenLaunchGroups (#13788)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("hides a group per project and never leaks it to another", () => {
    expect(setProjectLaunchGroupHidden("p1", "acme.records", true)).toEqual(["acme.records"]);
    expect(getProjectHiddenLaunchGroups("p1")).toEqual(["acme.records"]);
    expect(getProjectHiddenLaunchGroups("p2")).toEqual([]);
  });

  it("shows a group again and drops an emptied project", () => {
    setProjectLaunchGroupHidden("p1", "acme.records", true);
    setProjectLaunchGroupHidden("p1", "other.plugin", true);
    expect(setProjectLaunchGroupHidden("p1", "acme.records", false)).toEqual(["other.plugin"]);
    setProjectLaunchGroupHidden("p1", "other.plugin", false);
    expect(getProjectHiddenLaunchGroups("p1")).toEqual([]);
    expect(storeMock.data.get("projectHiddenLaunchGroups")).toEqual({});
  });

  it("writes nothing when the answer is already what was asked", () => {
    setProjectLaunchGroupHidden("p1", "acme.records", true);
    storeMock.set.mockClear();
    expect(setProjectLaunchGroupHidden("p1", "acme.records", true)).toEqual(["acme.records"]);
    expect(setProjectLaunchGroupHidden("p1", "never.hidden", false)).toEqual(["acme.records"]);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("skips malformed entries in a hand-edited store", () => {
    storeMock.data.set("projectHiddenLaunchGroups", {
      p1: ["acme.records", 42, "", "acme.records", "project__p1__acme.notes"],
      p2: "not a list",
    });
    expect(getProjectHiddenLaunchGroups("p1")).toEqual(["acme.records", "project__p1__acme.notes"]);
    expect(getProjectHiddenLaunchGroups("p2")).toEqual([]);
  });
});

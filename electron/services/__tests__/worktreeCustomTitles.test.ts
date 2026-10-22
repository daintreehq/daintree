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

vi.mock("../../store.js", () => ({ store: storeMock }));

import {
  clearWorktreeCustomTitles,
  getWorktreeCustomTitles,
  importLegacyWorktreeCustomTitles,
  onWorktreeCustomTitlesChanged,
  setWorktreeCustomTitle,
} from "../worktreeCustomTitles.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const SCRATCH = "0f8fad5b-d9cb-469f-a165-70867728950e";
const WT_1 = "/repos/alpha/feature-1";
const WT_2 = "/repos/alpha/feature-2";

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
});

describe("worktree custom titles in main", () => {
  it("reads empty at revision 0 for a workspace that never stored any", () => {
    expect(getWorktreeCustomTitles(PROJECT_A)).toEqual({ titles: {}, revision: 0 });
  });

  it("sets, normalises and clears a title, one revision per change", () => {
    expect(setWorktreeCustomTitle(PROJECT_A, WT_1, "  Release \n prep ")).toEqual({
      titles: { [WT_1]: "Release prep" },
      revision: 1,
    });
    expect(setWorktreeCustomTitle(PROJECT_A, WT_1, "   ")).toEqual({ titles: {}, revision: 2 });
    setWorktreeCustomTitle(PROJECT_A, WT_2, "Second");
    expect(setWorktreeCustomTitle(PROJECT_A, WT_2, null)).toEqual({ titles: {}, revision: 4 });
  });

  it("writes nothing and notifies no one for an unchanged title or a clear of none", () => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "Release prep");
    const listener = vi.fn();
    const off = onWorktreeCustomTitlesChanged(listener);
    storeMock.set.mockClear();

    expect(setWorktreeCustomTitle(PROJECT_A, WT_1, "Release  prep").revision).toBe(1);
    expect(setWorktreeCustomTitle(PROJECT_A, WT_2, null).revision).toBe(1);

    expect(storeMock.set).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("keeps each workspace's titles apart, scratches included", () => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "Alpha");
    setWorktreeCustomTitle(PROJECT_B, WT_1, "Beta");
    setWorktreeCustomTitle(SCRATCH, WT_1, "Scratch");

    expect(getWorktreeCustomTitles(PROJECT_A).titles).toEqual({ [WT_1]: "Alpha" });
    expect(getWorktreeCustomTitles(PROJECT_B).titles).toEqual({ [WT_1]: "Beta" });
    expect(getWorktreeCustomTitles(SCRATCH).titles).toEqual({ [WT_1]: "Scratch" });
  });

  it("refuses an over-long title, a bad worktree id and a non-workspace id", () => {
    expect(() => setWorktreeCustomTitle(PROJECT_A, WT_1, "x".repeat(81))).toThrow(/longer than/);
    expect(() => setWorktreeCustomTitle(PROJECT_A, "", "Title")).toThrow(/worktreeId/);
    expect(() => setWorktreeCustomTitle(PROJECT_A, "x".repeat(4097), "Title")).toThrow(
      /worktreeId/
    );
    expect(() => setWorktreeCustomTitle("default", WT_1, "Title")).toThrow(/workspace id/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("drops hand-edited entries that are blank, over-long or not strings", () => {
    storeMock.data.set("worktreeCustomTitles", {
      [PROJECT_A]: {
        titles: { [WT_1]: "  Kept  ", [WT_2]: "   ", "/x": "y".repeat(81), "/n": 7 },
        revision: 3,
      },
    });
    expect(getWorktreeCustomTitles(PROJECT_A)).toEqual({ titles: { [WT_1]: "Kept" }, revision: 3 });
  });

  it("leaves other workspaces' entries alone on a write", () => {
    setWorktreeCustomTitle(PROJECT_B, WT_1, "Beta");
    setWorktreeCustomTitle(PROJECT_A, WT_1, "Alpha");
    expect(storeMock.data.get("worktreeCustomTitles")).toEqual({
      [PROJECT_A]: { titles: { [WT_1]: "Alpha" }, revision: 1 },
      [PROJECT_B]: { titles: { [WT_1]: "Beta" }, revision: 1 },
    });
  });

  it("propagates an unreadable store instead of writing over every workspace", () => {
    storeMock.get.mockImplementation(() => {
      throw new Error("disk gone");
    });
    expect(() => setWorktreeCustomTitle(PROJECT_A, WT_1, "Alpha")).toThrow("disk gone");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("notifies listeners with the workspace id after a change, surviving a throwing one", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error("listener bug");
    });
    const listener = vi.fn();
    const offThrowing = onWorktreeCustomTitlesChanged(throwing);
    const off = onWorktreeCustomTitlesChanged(listener);

    setWorktreeCustomTitle(PROJECT_A, WT_1, "Alpha");
    expect(listener).toHaveBeenCalledWith(PROJECT_A);

    off();
    offThrowing();
    setWorktreeCustomTitle(PROJECT_A, WT_1, "Beta");
    expect(listener).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("clearing the titles of removed worktrees", () => {
  it("clears every held title in one write and notifies once", () => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "One");
    setWorktreeCustomTitle(PROJECT_A, WT_2, "Two");
    const listener = vi.fn();
    const off = onWorktreeCustomTitlesChanged(listener);

    expect(clearWorktreeCustomTitles(PROJECT_A, [WT_1, WT_2, "/never-titled"])).toEqual({
      titles: {},
      revision: 3,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("keeps the clear on disk, so no hand-over brings the title back", () => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "One");
    clearWorktreeCustomTitles(PROJECT_A, [WT_1]);

    expect(storeMock.data.get("worktreeCustomTitles")).toEqual({
      [PROJECT_A]: { titles: { [WT_1]: null }, revision: 2 },
    });
    expect(importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "One" }).titles).toEqual({});
  });

  it("writes nothing when none of the ids holds a title", () => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "One");
    clearWorktreeCustomTitles(PROJECT_A, [WT_1]);
    storeMock.set.mockClear();

    expect(clearWorktreeCustomTitles(PROJECT_A, [WT_1, WT_2]).revision).toBe(2);
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("handing over the titles a view kept in localStorage", () => {
  it("adopts the first hand-over for a workspace, normalised, and notifies", () => {
    const listener = vi.fn();
    const off = onWorktreeCustomTitlesChanged(listener);

    const stored = importLegacyWorktreeCustomTitles(PROJECT_A, {
      [WT_1]: " Release prep ",
      [WT_2]: "",
    });

    expect(stored).toEqual({ titles: { [WT_1]: "Release prep" }, revision: 1 });
    expect(listener).toHaveBeenCalledWith(PROJECT_A);
    off();
  });

  it("writes nothing for an empty hand-over, and a later one still lands", () => {
    const listener = vi.fn();
    const off = onWorktreeCustomTitlesChanged(listener);

    expect(importLegacyWorktreeCustomTitles(PROJECT_A, {})).toEqual({ titles: {}, revision: 0 });
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Late" }).titles).toEqual({
      [WT_1]: "Late",
    });
    off();
  });

  it("still takes the copy's titles after a write that never touched them", () => {
    // A remote view, which hands nothing over, renames another worktree first.
    setWorktreeCustomTitle(PROJECT_A, WT_2, "Remote rename");

    expect(importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Keep" })).toEqual({
      titles: { [WT_1]: "Keep", [WT_2]: "Remote rename" },
      revision: 2,
    });
  });

  it("never brings back a title cleared in main from a stale copy", () => {
    importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Old" });
    setWorktreeCustomTitle(PROJECT_A, WT_1, null);

    expect(importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Old" })).toEqual({
      titles: {},
      revision: 2,
    });
  });

  it("keeps a title main already holds over the copy's, and fills the rest", () => {
    setWorktreeCustomTitle(PROJECT_A, WT_1, "Newer");
    expect(
      importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Older", [WT_2]: "Other" })
    ).toEqual({ titles: { [WT_1]: "Newer", [WT_2]: "Other" }, revision: 2 });
  });

  it("is a no-op for a copy main has already taken", () => {
    importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Kept" });
    storeMock.set.mockClear();

    expect(importLegacyWorktreeCustomTitles(PROJECT_A, { [WT_1]: "Kept" }).revision).toBe(1);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("ignores a malformed hand-over and keys nothing off a prototype", () => {
    expect(importLegacyWorktreeCustomTitles(PROJECT_A, ["not", "a", "record"]).titles).toEqual({});
    const proto = importLegacyWorktreeCustomTitles(
      PROJECT_B,
      JSON.parse('{"__proto__": "Polluted"}') as unknown
    );
    expect(Object.hasOwn(proto.titles, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).Polluted).toBeUndefined();
    expect(Object.getPrototypeOf(proto.titles)).toBeNull();
  });
});

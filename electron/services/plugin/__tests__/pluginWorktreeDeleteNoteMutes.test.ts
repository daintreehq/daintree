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
  getWorktreeDeleteNoteMutes,
  isWorktreeDeleteNotesMuted,
  setWorktreeDeleteNotesEnabled,
} from "../pluginWorktreeDeleteNoteMutes.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE_A = `project__${PROJECT_A}__acme.records`;
const INSTANCE_B = `project__${PROJECT_B}__acme.records`;

describe("pluginWorktreeDeleteNoteMutes (#13805)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("starts with every plugin's notes on", () => {
    expect(isWorktreeDeleteNotesMuted("acme.records")).toBe(false);
    expect(getWorktreeDeleteNoteMutes()).toEqual([]);
  });

  it("mutes a project plugin in its own project and nowhere else", () => {
    expect(setWorktreeDeleteNotesEnabled(INSTANCE_A, false)).toBe(false);
    expect(isWorktreeDeleteNotesMuted(INSTANCE_A)).toBe(true);
    expect(isWorktreeDeleteNotesMuted(INSTANCE_B)).toBe(false);
    expect(isWorktreeDeleteNotesMuted("acme.records")).toBe(false);
  });

  it("turns notes back on, and writes nothing when already as asked", () => {
    setWorktreeDeleteNotesEnabled("acme.records", false);
    storeMock.set.mockClear();
    expect(setWorktreeDeleteNotesEnabled("acme.records", false)).toBe(false);
    expect(setWorktreeDeleteNotesEnabled("never.muted", true)).toBe(true);
    expect(storeMock.set).not.toHaveBeenCalled();

    expect(setWorktreeDeleteNotesEnabled("acme.records", true)).toBe(true);
    expect(storeMock.data.get("pluginWorktreeDeleteNoteMutes")).toEqual([]);
  });

  it("skips malformed entries a hand edit left in the file", () => {
    storeMock.data.set("pluginWorktreeDeleteNoteMutes", [
      "acme.records",
      42,
      "../escape",
      "acme.records",
    ]);
    expect(getWorktreeDeleteNoteMutes()).toEqual(["acme.records"]);
    storeMock.data.set("pluginWorktreeDeleteNoteMutes", "acme.records");
    expect(getWorktreeDeleteNoteMutes()).toEqual([]);
  });
});

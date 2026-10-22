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
  getProjectFileEditorChoices,
  setProjectFileEditorChoice,
} from "../projectFileEditorChoices.js";

describe("projectFileEditorChoices (#13809)", () => {
  beforeEach(() => {
    storeMock.data.clear();
  });

  it("remembers an answer per project and never leaks it to another", () => {
    setProjectFileEditorChoice("p1", "edit:json", "acme.records/records");
    expect(getProjectFileEditorChoices("p1")).toEqual({ "edit:json": "acme.records/records" });
    expect(getProjectFileEditorChoices("p2")).toEqual({});
  });

  it("forgets an answer with null and drops an emptied project", () => {
    setProjectFileEditorChoice("p1", "view:csv", "host");
    setProjectFileEditorChoice("p1", "view:csv", null);
    expect(getProjectFileEditorChoices("p1")).toEqual({});
    expect(storeMock.data.get("projectFileEditorChoices")).toEqual({});
  });

  it("skips malformed entries in a hand-edited store", () => {
    storeMock.data.set("projectFileEditorChoices", {
      p1: {
        "edit:json": "acme.records/records",
        "edit:../x": "acme.records/records",
        "open:json": "host",
        "view:csv": 42,
        "view:*": "host",
      },
      p2: "not an object",
    });
    expect(getProjectFileEditorChoices("p1")).toEqual({
      "edit:json": "acme.records/records",
      "view:*": "host",
    });
    expect(getProjectFileEditorChoices("p2")).toEqual({});
  });
});

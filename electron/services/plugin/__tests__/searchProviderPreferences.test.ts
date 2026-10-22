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
  canSetSearchProviderFrom,
  getHiddenSearchProviders,
  isSearchProviderKey,
  setSearchProviderShown,
} from "../searchProviderPreferences.js";

const PROJECT_PROVIDER = "project__p1__acme.notes.notes";

describe("searchProviderPreferences (#13792)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("hides and shows a provider by its key", () => {
    expect(setSearchProviderShown("acme.notes.notes", false)).toEqual(["acme.notes.notes"]);
    expect(setSearchProviderShown(PROJECT_PROVIDER, false)).toEqual([
      "acme.notes.notes",
      PROJECT_PROVIDER,
    ]);
    expect(setSearchProviderShown("acme.notes.notes", true)).toEqual([PROJECT_PROVIDER]);
    expect(getHiddenSearchProviders()).toEqual([PROJECT_PROVIDER]);
  });

  it("writes nothing for a choice that is already in place", () => {
    setSearchProviderShown("acme.notes.notes", true);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("reads back only well-formed keys from a hand-edited file", () => {
    storeMock.data.set("hiddenSearchProviders", [
      "acme.notes.notes",
      "",
      42,
      "acme.notes.notes",
      "x".repeat(401),
    ]);
    expect(getHiddenSearchProviders()).toEqual(["acme.notes.notes"]);
    storeMock.data.set("hiddenSearchProviders", { not: "a list" });
    expect(getHiddenSearchProviders()).toEqual([]);
  });

  it("lets only a project plugin's own project switch its providers", () => {
    expect(canSetSearchProviderFrom(PROJECT_PROVIDER, "p1")).toBe(true);
    expect(canSetSearchProviderFrom(PROJECT_PROVIDER, "p2")).toBe(false);
    expect(canSetSearchProviderFrom(PROJECT_PROVIDER, null)).toBe(false);
    expect(canSetSearchProviderFrom("acme.notes.notes", "p2")).toBe(true);
    expect(canSetSearchProviderFrom("acme.notes.notes", null)).toBe(true);
  });

  it("checks a key's shape for the IPC gate", () => {
    expect(isSearchProviderKey("acme.notes.notes")).toBe(true);
    expect(isSearchProviderKey("")).toBe(false);
    expect(isSearchProviderKey(7)).toBe(false);
  });
});

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
  __resetProjectPluginVisibilityForTesting,
  clearProjectPluginVisibilityForPlugin,
  getProjectPluginVisibility,
  hasProjectPluginVisibilityOverrides,
  isPluginVisibleInProject,
  setPluginVisibilityDefault,
  setProjectPluginVisibility,
} from "../projectPluginVisibility.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockClear();
  storeMock.set.mockClear();
  __resetProjectPluginVisibilityForTesting();
});

describe("projectPluginVisibility", () => {
  it("is empty and fully permissive before anything is decided", () => {
    expect(hasProjectPluginVisibilityOverrides()).toBe(false);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", null)).toBe(true);
  });

  it("hides a plugin in one project and leaves every other project alone", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);

    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(false);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(true);
    expect(isPluginVisibleInProject("acme.other", PROJECT_A)).toBe(true);
  });

  it("expresses 'only in the projects I pick' through the default plus an override", () => {
    setPluginVisibilityDefault("acme.tools", true);

    // Hidden everywhere, including in projects that do not exist yet.
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(false);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(false);

    setProjectPluginVisibility(PROJECT_A, "acme.tools", true);

    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(false);
  });

  it("falls back to the default for a view with no project binding", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    expect(isPluginVisibleInProject("acme.tools", null)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", "")).toBe(true);

    setPluginVisibilityDefault("acme.tools", true);
    expect(isPluginVisibleInProject("acme.tools", null)).toBe(false);
  });

  it("clearing an override returns the project to the default, in both directions", () => {
    setPluginVisibilityDefault("acme.tools", true);
    setProjectPluginVisibility(PROJECT_A, "acme.tools", true);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);

    setProjectPluginVisibility(PROJECT_A, "acme.tools", null);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(false);
  });

  it("changing the default leaves explicit project answers standing", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    setPluginVisibilityDefault("acme.tools", true);
    setPluginVisibilityDefault("acme.tools", false);

    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(false);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(true);
  });

  it("reports no change for a redundant write, so callers skip the rebroadcast", () => {
    expect(setProjectPluginVisibility(PROJECT_A, "acme.tools", false)).toBe(true);
    expect(setProjectPluginVisibility(PROJECT_A, "acme.tools", false)).toBe(false);
    expect(setProjectPluginVisibility(PROJECT_A, "acme.tools", null)).toBe(true);
    expect(setProjectPluginVisibility(PROJECT_A, "acme.tools", null)).toBe(false);

    expect(setPluginVisibilityDefault("acme.tools", true)).toBe(true);
    expect(setPluginVisibilityDefault("acme.tools", true)).toBe(false);
  });

  it("returns to the identity fast path once the last decision is cleared", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    expect(hasProjectPluginVisibilityOverrides()).toBe(true);

    setProjectPluginVisibility(PROJECT_A, "acme.tools", null);
    expect(hasProjectPluginVisibilityOverrides()).toBe(false);
  });

  it("persists and rehydrates both levels", () => {
    setPluginVisibilityDefault("acme.tools", true);
    setProjectPluginVisibility(PROJECT_A, "acme.tools", true);
    setProjectPluginVisibility(PROJECT_B, "acme.other", false);

    __resetProjectPluginVisibilityForTesting();

    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(false);
    expect(isPluginVisibleInProject("acme.other", PROJECT_B)).toBe(false);
  });

  it("reports the profile as one project sees it", () => {
    setPluginVisibilityDefault("acme.tools", true);
    setProjectPluginVisibility(PROJECT_A, "acme.tools", true);

    expect(getProjectPluginVisibility(PROJECT_A)).toEqual({
      defaultHiddenPluginIds: ["acme.tools"],
      overrides: { "acme.tools": true },
    });
    expect(getProjectPluginVisibility(PROJECT_B)).toEqual({
      defaultHiddenPluginIds: ["acme.tools"],
      overrides: {},
    });
  });

  it("fails open on a malformed stored profile rather than hiding anything", () => {
    storeMock.data.set("projectPluginVisibility", {
      defaultHiddenPluginIds: "not-an-array",
      projectOverrides: {
        "not-a-project-id": { "acme.tools": false },
        [PROJECT_A]: { "acme.tools": "yes", "": true },
      },
    });

    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(hasProjectPluginVisibilityOverrides()).toBe(false);
  });

  it("survives a store read that throws", () => {
    storeMock.get.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
  });

  it("rejects a project id that is not a project workspace id", () => {
    expect(() => setProjectPluginVisibility("nope", "acme.tools", false)).toThrow(
      /project workspace id/
    );
  });

  it("rejects an empty plugin id on both setters", () => {
    expect(() => setProjectPluginVisibility(PROJECT_A, "", false)).toThrow(/non-empty/);
    expect(() => setPluginVisibilityDefault("", true)).toThrow(/non-empty/);
  });

  it("drops every rule about a plugin when it is uninstalled", () => {
    setPluginVisibilityDefault("acme.tools", true);
    setProjectPluginVisibility(PROJECT_A, "acme.tools", true);
    setProjectPluginVisibility(PROJECT_B, "acme.other", false);

    clearProjectPluginVisibilityForPlugin("acme.tools");

    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(getProjectPluginVisibility(PROJECT_A).defaultHiddenPluginIds).toEqual([]);
    // A rule about a different plugin is untouched.
    expect(isPluginVisibleInProject("acme.other", PROJECT_B)).toBe(false);
  });

  it("propagates a failed write instead of reporting success", () => {
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => setProjectPluginVisibility(PROJECT_A, "acme.tools", false)).toThrow(/disk full/);
  });
});

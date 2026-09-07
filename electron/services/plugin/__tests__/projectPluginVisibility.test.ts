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
  // mockReset, not mockClear: a test that installs a persistent throwing
  // implementation would otherwise leak it into every test after it.
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
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

  it("shows the plugin in a view with no project binding, whatever the rules say", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    expect(isPluginVisibleInProject("acme.tools", null)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", "")).toBe(true);

    // Both halves of the overlay are statements about projects, and the project
    // picker is not one — "only in the projects I pick" must not hide a plugin
    // from the one window where its absence is hardest to explain.
    setPluginVisibilityDefault("acme.tools", true);
    expect(isPluginVisibleInProject("acme.tools", null)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", "")).toBe(true);
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

  it("retries a failed read instead of staying empty for the session", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    __resetProjectPluginVisibilityForTesting();

    storeMock.get.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    // First call fails open...
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    // ...and the next one picks the rules back up rather than having latched.
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(false);
  });

  it("refuses to overwrite rules it could not read", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    const stored = storeMock.data.get("projectPluginVisibility");
    __resetProjectPluginVisibilityForTesting();
    storeMock.get.mockImplementation(() => {
      throw new Error("unreadable");
    });

    // `persist()` rewrites the whole key, so writing from an unhydrated (empty)
    // map would delete every stored rule on the strength of one failed read.
    expect(() => setProjectPluginVisibility(PROJECT_B, "acme.other", false)).toThrow(
      /refusing to overwrite/
    );
    expect(storeMock.data.get("projectPluginVisibility")).toEqual(stored);
  });

  it("keeps an uninstall purge atomic when the write fails", () => {
    setPluginVisibilityDefault("acme.tools", true);
    setProjectPluginVisibility(PROJECT_A, "acme.tools", true);
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => clearProjectPluginVisibilityForPlugin("acme.tools")).toThrow();

    // The uninstall path swallows the error, so a half-applied purge would let
    // a plugin reclaiming this id inherit the rules after a restart.
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(false);
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

  it("leaves memory matching disk when a write fails", () => {
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => setProjectPluginVisibility(PROJECT_A, "acme.tools", false)).toThrow();

    // The filter reads this map on every broadcast. A change that never reached
    // disk must not go on hiding the plugin for the rest of the session while
    // the renderer, which saw the same error, shows it as visible.
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(true);
    expect(hasProjectPluginVisibilityOverrides()).toBe(false);
  });

  it("restores a previous override when overwriting it fails", () => {
    setProjectPluginVisibility(PROJECT_A, "acme.tools", false);
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => setProjectPluginVisibility(PROJECT_A, "acme.tools", true)).toThrow();
    expect(isPluginVisibleInProject("acme.tools", PROJECT_A)).toBe(false);
  });

  it("leaves the default set unchanged when its write fails", () => {
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => setPluginVisibilityDefault("acme.tools", true)).toThrow();

    expect(isPluginVisibleInProject("acme.tools", PROJECT_B)).toBe(true);
    expect(getProjectPluginVisibility(PROJECT_A).defaultHiddenPluginIds).toEqual([]);
  });
});

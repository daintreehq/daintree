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

import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";
import {
  claimProjectSurface,
  clearAllProjectSurfaces,
  releasePluginSurfaces,
} from "../PluginSurfaceRegistry.js";
import { getProjectSurfaceChoices, setProjectSurfaceChoice } from "../projectSurfaceChoices.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE_A = makeProjectPluginInstanceKey(PROJECT_A, "acme.dash");

function claimCanvas(instanceKey = INSTANCE_A, projectId = PROJECT_A) {
  claimProjectSurface(projectId, "emptyCanvas", {
    pluginId: instanceKey,
    panelKindId: `project:${projectId}/acme.dash/overview`,
  });
}

beforeEach(() => {
  storeMock.data.clear();
  // mockReset, not mockClear: a test that installs a throwing implementation
  // would otherwise leak it into every test after it.
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
  clearAllProjectSurfaces();
});

describe("projectSurfaceChoices", () => {
  it("has no answers before anything is decided", () => {
    expect(getProjectSurfaceChoices(PROJECT_A)).toEqual({});
  });

  it("records the answer against the slot owner's manifest id and reads it back", () => {
    claimCanvas();

    const returned = setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock", 123);

    // The manifest id, not the instance key: the instance key embeds this
    // machine's project id, and a reinstall of the same plugin is the same
    // plugin as far as the user's answer goes.
    const expected = { emptyCanvas: { pluginId: "acme.dash", choice: "stock", decidedAt: 123 } };
    expect(returned).toEqual(expected);
    expect(getProjectSurfaceChoices(PROJECT_A)).toEqual(expected);
    expect(getProjectSurfaceChoices(PROJECT_B)).toEqual({});
  });

  it("refuses an answer when nothing claims the slot", () => {
    // A renderer must not be able to pre-answer for a plugin that has not
    // claimed the canvas yet.
    expect(() => setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface")).toThrow(
      /no plugin claims emptyCanvas/
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("keeps the answer after the plugin unloads, so a reload finds it", () => {
    claimCanvas();
    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock", 1);

    releasePluginSurfaces(INSTANCE_A);

    expect(getProjectSurfaceChoices(PROJECT_A).emptyCanvas?.choice).toBe("stock");
  });

  it("forgets an answer with null, even once nothing claims the slot", () => {
    claimCanvas();
    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", 1);
    releasePluginSurfaces(INSTANCE_A);

    expect(setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", null)).toEqual({});
    expect(getProjectSurfaceChoices(PROJECT_A)).toEqual({});
    // An emptied project leaves no key behind.
    expect(storeMock.data.get("projectSurfaceChoices")).toEqual({});
  });

  it("rewrites the key without touching another project's answers", () => {
    const other = { emptyCanvas: { pluginId: "acme.other", choice: "stock", decidedAt: 9 } };
    storeMock.data.set("projectSurfaceChoices", { [PROJECT_B]: other });
    claimCanvas();

    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", 5);

    expect(storeMock.data.get("projectSurfaceChoices")).toEqual({
      [PROJECT_B]: other,
      [PROJECT_A]: { emptyCanvas: { pluginId: "acme.dash", choice: "surface", decidedAt: 5 } },
    });
  });

  it("rejects a malformed project id, slot or choice", () => {
    claimCanvas();

    expect(() => setProjectSurfaceChoice("not-a-project", "emptyCanvas", "stock")).toThrow(
      /project workspace id/
    );
    expect(() =>
      setProjectSurfaceChoice(PROJECT_A, "projectHome" as unknown as "emptyCanvas", "stock")
    ).toThrow(/unknown surface slot/);
    expect(() =>
      setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "hidden" as unknown as "stock")
    ).toThrow(/choice must be/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("skips malformed stored answers rather than trusting them", () => {
    storeMock.data.set("projectSurfaceChoices", {
      [PROJECT_A]: {
        emptyCanvas: { pluginId: "", choice: "stock", decidedAt: 1 },
        projectHome: { pluginId: "acme.dash", choice: "stock", decidedAt: 1 },
      },
      [PROJECT_B]: { emptyCanvas: { pluginId: "acme.dash", choice: "surface" } },
    });

    expect(getProjectSurfaceChoices(PROJECT_A)).toEqual({});
    expect(getProjectSurfaceChoices(PROJECT_B)).toEqual({
      emptyCanvas: { pluginId: "acme.dash", choice: "surface", decidedAt: 0 },
    });
  });

  it("surfaces a read failure rather than reading it as no answers", () => {
    // Read as empty, an unreadable store would put a canvas the user switched
    // off back on screen and ask them again.
    storeMock.get.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => getProjectSurfaceChoices(PROJECT_A)).toThrow(/EACCES/);
  });

  it("keeps an answer about a slot this build does not know when writing another", () => {
    // Written by a newer build; a downgrade must not erase it on its first save.
    const future = { pluginId: "acme.dash", choice: "stock", decidedAt: 1 };
    storeMock.data.set("projectSurfaceChoices", { [PROJECT_A]: { projectHome: future } });
    claimCanvas();

    const returned = setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", 7);

    expect(returned).toEqual({
      emptyCanvas: { pluginId: "acme.dash", choice: "surface", decidedAt: 7 },
    });
    expect(storeMock.data.get("projectSurfaceChoices")).toEqual({
      [PROJECT_A]: {
        projectHome: future,
        emptyCanvas: { pluginId: "acme.dash", choice: "surface", decidedAt: 7 },
      },
    });
  });

  it("refuses to rewrite a key it could not read", () => {
    claimCanvas();
    storeMock.get.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock")).toThrow(/EACCES/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("surfaces a failed write to the caller", () => {
    claimCanvas();
    storeMock.set.mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    expect(() => setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock")).toThrow(/ENOSPC/);
  });
});

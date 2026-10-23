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
  fileEditorSlotKey,
  makeProjectPluginInstanceKey,
  type ProjectSurfaceSlot,
  type ProjectSurfaceSlotKey,
} from "../../../../shared/types/plugin.js";
import { claimProjectSurface, clearAllProjectSurfaces } from "../PluginSurfaceRegistry.js";
import { getProjectSurfaceChoices, setProjectSurfaceChoices } from "../projectSurfaceChoices.js";

const PROJECT = "a".repeat(64);
const ACME = makeProjectPluginInstanceKey(PROJECT, "acme.dash");
const OTHER = makeProjectPluginInstanceKey(PROJECT, "acme.other");
const HOME: ProjectSurfaceSlot = "projectHome";

function claim(slot: ProjectSurfaceSlot, pluginId: string) {
  claimProjectSurface(PROJECT, slot, {
    pluginId,
    scope: "project",
    value: { kind: "view", viewId: "overview", panelKindId: `project:${PROJECT}/x/${slot}` },
  });
}

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
  clearAllProjectSurfaces();
});

describe("an answer about several slots", () => {
  it("records every slot in one write", () => {
    claim("emptyCanvas", ACME);
    claim(HOME, ACME);

    const returned = setProjectSurfaceChoices(
      PROJECT,
      [
        { slot: "emptyCanvas", choice: "stock", ownerId: ACME },
        { slot: HOME, choice: "stock", ownerId: ACME },
      ],
      4
    );

    const answer = { pluginId: "acme.dash", choice: "stock", decidedAt: 4 };
    const expected = { emptyCanvas: answer, projectHome: answer };
    expect(returned).toEqual(expected);
    expect(getProjectSurfaceChoices(PROJECT)).toEqual(expected);
    expect(storeMock.set).toHaveBeenCalledTimes(1);
  });

  it("records none of it when one slot has changed hands since the question", () => {
    claim("emptyCanvas", ACME);
    claim(HOME, OTHER);

    expect(() =>
      setProjectSurfaceChoices(PROJECT, [
        { slot: "emptyCanvas", choice: "surface", ownerId: ACME },
        { slot: HOME, choice: "surface", ownerId: ACME },
      ])
    ).toThrow(/projectHome has passed to another plugin/);
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(getProjectSurfaceChoices(PROJECT)).toEqual({});
  });

  it("records none of it when one slot has nothing on offer", () => {
    claim("emptyCanvas", ACME);

    expect(() =>
      setProjectSurfaceChoices(PROJECT, [
        { slot: "emptyCanvas", choice: "surface" },
        { slot: HOME, choice: "surface" },
      ])
    ).toThrow(/no plugin claims projectHome/);
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("an answer about a plugin's default editors (#13811)", () => {
  // A pattern with dots and slashes, which an electron-store dot path would
  // have split into nested keys.
  const PAGES = fileEditorSlotKey("content/pages/*.json");
  const ABOUT = fileEditorSlotKey("content/about.json");

  function claimDefault(slot: ProjectSurfaceSlotKey, pluginId: string) {
    claimProjectSurface(PROJECT, slot, {
      pluginId,
      scope: "project",
      value: { kind: "data", data: { editorId: "records" } },
    });
  }

  it("records a catalogue slot and the plugin's pattern slots in one write, and reads them back", () => {
    claim("emptyCanvas", ACME);
    claimDefault(PAGES, ACME);
    claimDefault(ABOUT, ACME);

    setProjectSurfaceChoices(
      PROJECT,
      [
        { slot: "emptyCanvas", choice: "surface", ownerId: ACME },
        { slot: PAGES, choice: "stock", ownerId: ACME },
        { slot: ABOUT, choice: "surface", ownerId: ACME },
      ],
      7
    );

    expect(storeMock.set).toHaveBeenCalledTimes(1);
    expect(getProjectSurfaceChoices(PROJECT)).toEqual({
      emptyCanvas: { pluginId: "acme.dash", choice: "surface", decidedAt: 7 },
      [PAGES]: { pluginId: "acme.dash", choice: "stock", decidedAt: 7 },
      [ABOUT]: { pluginId: "acme.dash", choice: "surface", decidedAt: 7 },
    });
  });

  it("forgets one pattern's answer and leaves the others", () => {
    claimDefault(PAGES, ACME);
    claimDefault(ABOUT, ACME);
    setProjectSurfaceChoices(
      PROJECT,
      [
        { slot: PAGES, choice: "stock", ownerId: ACME },
        { slot: ABOUT, choice: "stock", ownerId: ACME },
      ],
      3
    );

    setProjectSurfaceChoices(PROJECT, [{ slot: PAGES, choice: null }]);

    expect(getProjectSurfaceChoices(PROJECT)).toEqual({
      [ABOUT]: { pluginId: "acme.dash", choice: "stock", decidedAt: 3 },
    });
  });

  it("refuses an answer about a pattern no plugin made a default here", () => {
    expect(() => setProjectSurfaceChoices(PROJECT, [{ slot: PAGES, choice: "surface" }])).toThrow(
      /no plugin claims fileEditor:content\/pages\/\*\.json/
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

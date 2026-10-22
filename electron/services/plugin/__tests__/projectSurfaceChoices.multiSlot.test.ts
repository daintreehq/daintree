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
  makeProjectPluginInstanceKey,
  type ProjectSurfaceSlot,
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

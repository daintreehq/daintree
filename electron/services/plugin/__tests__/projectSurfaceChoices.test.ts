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
  type ProjectSurfaceSlotState,
} from "../../../../shared/types/plugin.js";
import {
  claimProjectSurface,
  clearAllProjectSurfaces,
  releasePluginSurfaces,
} from "../PluginSurfaceRegistry.js";
import {
  buildProjectSurfaceChoiceRecord,
  getProjectSurfaceChoices,
  parseProjectSurfaceChoiceRecord,
  setProjectSurfaceChoice,
  setProjectSurfaceChoices,
} from "../projectSurfaceChoices.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE_A = makeProjectPluginInstanceKey(PROJECT_A, "acme.dash");

function claimCanvas(instanceKey = INSTANCE_A, projectId = PROJECT_A) {
  claimProjectSurface(projectId, "emptyCanvas", {
    pluginId: instanceKey,
    scope: "project",
    value: {
      kind: "view",
      viewId: "overview",
      panelKindId: `project:${projectId}/acme.dash/overview`,
    },
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
  it("records the answer against the slot owner's manifest id and reads it back", () => {
    claimCanvas();

    const returned = setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock", undefined, 123);

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
    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock", undefined, 1);

    releasePluginSurfaces(INSTANCE_A);

    expect(getProjectSurfaceChoices(PROJECT_A).emptyCanvas?.choice).toBe("stock");
  });

  it("forgets an answer with null, even once nothing claims the slot", () => {
    claimCanvas();
    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", undefined, 1);
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

    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", undefined, 5);

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

    const returned = setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", undefined, 7);

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
  it("records the answer against the slot's ranked owner, not the first to claim it", () => {
    const zeta = makeProjectPluginInstanceKey(PROJECT_A, "zeta.dash");
    claimCanvas(zeta);
    claimCanvas();

    expect(setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock", undefined, 3)).toEqual({
      emptyCanvas: { pluginId: "acme.dash", choice: "stock", decidedAt: 3 },
    });
  });

  it("refuses an option id on an exclusive slot, whose one option is its owner", () => {
    claimCanvas();
    expect(() => setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "surface", INSTANCE_A)).toThrow(
      /has one option/
    );
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("answers about several slots at once", () => {
  it("records every slot of one answer in a single write", () => {
    claimCanvas();

    const returned = setProjectSurfaceChoices(
      PROJECT_A,
      [{ slot: "emptyCanvas", choice: "stock" }],
      7
    );

    expect(returned).toEqual({
      emptyCanvas: { pluginId: "acme.dash", choice: "stock", decidedAt: 7 },
    });
    expect(storeMock.set).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer about a plugin the slot has passed from, writing nothing", () => {
    claimCanvas();
    const other = makeProjectPluginInstanceKey(PROJECT_A, "acme.other");

    // The user answered about acme.other; acme.dash holds the slot by the time
    // the answer arrives, and it was never asked.
    expect(() =>
      setProjectSurfaceChoices(PROJECT_A, [
        { slot: "emptyCanvas", choice: "stock", ownerId: other },
      ])
    ).toThrow(/has passed to another plugin/);
    expect(storeMock.set).not.toHaveBeenCalled();

    setProjectSurfaceChoices(
      PROJECT_A,
      [{ slot: "emptyCanvas", choice: "stock", ownerId: INSTANCE_A }],
      3
    );
    expect(getProjectSurfaceChoices(PROJECT_A).emptyCanvas).toEqual({
      pluginId: "acme.dash",
      choice: "stock",
      decidedAt: 3,
    });
  });

  it("writes nothing when any part of the answer is bad", () => {
    claimCanvas();
    setProjectSurfaceChoice(PROJECT_A, "emptyCanvas", "stock", undefined, 1);
    storeMock.set.mockClear();

    // The forget is fine on its own; the slot after it is not, so neither lands.
    expect(() =>
      setProjectSurfaceChoices(PROJECT_A, [
        { slot: "emptyCanvas", choice: null },
        { slot: "projectHome" as unknown as "emptyCanvas", choice: "stock" },
      ])
    ).toThrow(/unknown surface slot/);
    expect(() =>
      setProjectSurfaceChoices(PROJECT_A, [
        { slot: "emptyCanvas", choice: null },
        { slot: "emptyCanvas", choice: "surface" },
      ])
    ).toThrow(/answered twice/);
    expect(() => setProjectSurfaceChoices(PROJECT_A, [])).toThrow(/at least one slot/);

    expect(storeMock.set).not.toHaveBeenCalled();
    expect(getProjectSurfaceChoices(PROJECT_A).emptyCanvas?.choice).toBe("stock");
  });
});

describe("selectable slot answers", () => {
  const projectOption = makeProjectPluginInstanceKey(PROJECT_A, "acme.side");
  const installedOption = "acme.side";
  const state: ProjectSurfaceSlotState = {
    mode: "selectable",
    options: [
      { pluginId: projectOption, scope: "project", value: { kind: "view", viewId: "side" } },
      { pluginId: installedOption, scope: "installed", value: { kind: "view", viewId: "side" } },
    ],
    defaultOptionId: projectOption,
    refused: [],
  };

  it("names the picked option by instance key, telling same-id plugins apart", () => {
    expect(
      buildProjectSurfaceChoiceRecord(
        "selectable",
        "emptyCanvas",
        state,
        "surface",
        installedOption,
        4
      )
    ).toEqual({
      pluginId: "acme.side",
      choice: "surface",
      decidedAt: 4,
      optionId: installedOption,
    });
  });

  it("records stock without any plugin claiming the slot", () => {
    expect(
      buildProjectSurfaceChoiceRecord("selectable", "emptyCanvas", undefined, "stock", undefined, 4)
    ).toEqual({ pluginId: "", choice: "stock", decidedAt: 4 });
  });

  it("refuses an option that is not on offer", () => {
    expect(() =>
      buildProjectSurfaceChoiceRecord("selectable", "emptyCanvas", state, "surface", "ghost", 4)
    ).toThrow(/offers no such option/);
    expect(() =>
      buildProjectSurfaceChoiceRecord("selectable", "emptyCanvas", state, "surface", undefined, 4)
    ).toThrow(/offers no such option/);
  });

  it("parses what it builds and skips a plugin answer with no option", () => {
    const record = buildProjectSurfaceChoiceRecord(
      "selectable",
      "emptyCanvas",
      state,
      "surface",
      projectOption,
      9
    );
    expect(parseProjectSurfaceChoiceRecord(record, "selectable")).toEqual(record);
    expect(
      parseProjectSurfaceChoiceRecord({ pluginId: "acme.side", choice: "surface" }, "selectable")
    ).toBeUndefined();
    expect(
      parseProjectSurfaceChoiceRecord({ pluginId: "", choice: "stock", decidedAt: 2 }, "selectable")
    ).toEqual({ pluginId: "", choice: "stock", decidedAt: 2 });
    // An exclusive answer must still name its plugin.
    expect(
      parseProjectSurfaceChoiceRecord({ pluginId: "", choice: "stock" }, "exclusive")
    ).toBeUndefined();
  });
});

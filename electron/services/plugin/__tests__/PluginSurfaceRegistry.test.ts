import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectSurfaceSlotClaim } from "../../../../shared/types/plugin.js";
import {
  arbitrateProjectSurfaceSlot,
  bumpProjectSurfaceRevision,
  claimProjectSurface,
  clearAllProjectSurfaces,
  getProjectSurfaceRefusals,
  getProjectSurfaceRevision,
  getProjectSurfaceSlots,
  refuseProjectSurface,
  releasePluginSurfaces,
} from "../PluginSurfaceRegistry.js";

function view(pluginId: string, panelKindId: string): ProjectSurfaceSlotClaim {
  return {
    pluginId,
    scope: "project",
    value: { kind: "view", viewId: panelKindId.split("/").pop() ?? "v", panelKindId },
  };
}

const acme = view("project__p1__acme.dash", "project:p1/acme.dash/overview");
const other = view("project__p1__other.dash", "project:p1/other.dash/home");

function ownerOf(projectId: string): string | null {
  return getProjectSurfaceSlots(projectId).emptyCanvas?.defaultOptionId ?? null;
}

beforeEach(() => {
  clearAllProjectSurfaces();
});

describe("project slot claims (§7.8)", () => {
  it("records a claim against its project only", () => {
    expect(claimProjectSurface("p1", "emptyCanvas", acme)).toEqual({ ok: true });
    expect(getProjectSurfaceSlots("p1")).toEqual({
      emptyCanvas: {
        mode: "exclusive",
        options: [acme],
        defaultOptionId: acme.pluginId,
        refused: [],
      },
    });
    // The whole point of the registry being project-keyed: a second project
    // sees nothing, so its canvas is the host's own.
    expect(getProjectSurfaceSlots("p2")).toEqual({});
  });

  it("gives an exclusive slot to the same plugin whichever claim arrives first", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    expect(claimProjectSurface("p1", "emptyCanvas", other)).toEqual({
      ok: false,
      reason: "outranked",
      heldBy: acme.pluginId,
    });
    const forward = getProjectSurfaceSlots("p1");

    clearAllProjectSurfaces();
    claimProjectSurface("p1", "emptyCanvas", other);
    // The later, lower-sorting claim takes the slot and says whom it displaced.
    expect(claimProjectSurface("p1", "emptyCanvas", acme)).toEqual({
      ok: true,
      displaced: other.pluginId,
    });
    expect(getProjectSurfaceSlots("p1")).toEqual(forward);
    expect(forward.emptyCanvas?.refused).toEqual([
      { slot: "emptyCanvas", pluginId: other.pluginId, reason: "outranked", heldBy: acme.pluginId },
    ]);
  });

  it("hands the slot back to its owner across the owner's own reload", () => {
    // The dev-rebuild bug: unload released the owner's claim and the reload's
    // re-claim joined the back of a queue, handing the slot to the runner-up.
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);

    releasePluginSurfaces(acme.pluginId);
    expect(ownerOf("p1")).toBe(other.pluginId);

    const reloaded = view(acme.pluginId, "project:p1/acme.dash/overview-v2");
    expect(claimProjectSurface("p1", "emptyCanvas", reloaded)).toEqual({
      ok: true,
      displaced: other.pluginId,
    });
    expect(getProjectSurfaceSlots("p1").emptyCanvas?.options).toEqual([reloaded]);
  });

  it("lets the same plugin re-claim its own slot", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    const moved = view(acme.pluginId, "project:p1/acme.dash/overview-v2");
    expect(claimProjectSurface("p1", "emptyCanvas", moved)).toEqual({ ok: true });
    expect(getProjectSurfaceSlots("p1").emptyCanvas?.options).toEqual([moved]);
  });

  it("keeps a losing claimant's refusal across its own reload", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);
    const reloaded = view(other.pluginId, "project:p1/other.dash/home-v2");
    expect(claimProjectSurface("p1", "emptyCanvas", reloaded)).toEqual({
      ok: false,
      reason: "outranked",
      heldBy: acme.pluginId,
    });

    releasePluginSurfaces(acme.pluginId);
    expect(getProjectSurfaceSlots("p1").emptyCanvas?.options).toEqual([reloaded]);
  });

  it("lets two projects claim the same slot independently", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    expect(claimProjectSurface("p2", "emptyCanvas", other)).toEqual({ ok: true });
    expect(ownerOf("p1")).toBe(acme.pluginId);
    expect(ownerOf("p2")).toBe(other.pluginId);
  });

  it("releases a plugin's claims and reports the projects it touched", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p2", "emptyCanvas", view(acme.pluginId, "project:p2/acme.dash/o"));
    expect(releasePluginSurfaces(acme.pluginId).sort()).toEqual(["p1", "p2"]);
    expect(getProjectSurfaceSlots("p1")).toEqual({});
    expect(getProjectSurfaceSlots("p2")).toEqual({});
  });

  it("promotes the refused claimant when the owner unloads", () => {
    // Nothing rescans a plugin that is already loaded, so without this the slot
    // would revert to stock for the life of the app even though a valid,
    // still-loaded claimant is sitting right there.
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);

    expect(releasePluginSurfaces(acme.pluginId)).toEqual(["p1"]);
    expect(getProjectSurfaceSlots("p1").emptyCanvas).toEqual({
      mode: "exclusive",
      options: [other],
      defaultOptionId: other.pluginId,
      refused: [],
    });
  });

  it("reports the project when a losing claimant unloads, since its refusal goes", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);

    expect(releasePluginSurfaces(other.pluginId)).toEqual(["p1"]);
    expect(getProjectSurfaceSlots("p1").emptyCanvas?.refused).toEqual([]);
    expect(ownerOf("p1")).toBe(acme.pluginId);
  });

  it("is idempotent on release", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    releasePluginSurfaces(acme.pluginId);
    expect(releasePluginSurfaces(acme.pluginId)).toEqual([]);
    expect(getProjectSurfaceSlots("p1")).toEqual({});
  });

  it("refuses an installed plugin's claim on an exclusive slot", () => {
    const installed: ProjectSurfaceSlotClaim = {
      ...view("acme.dash", "acme.dash/overview"),
      scope: "installed",
    };
    expect(claimProjectSurface("p1", "emptyCanvas", installed)).toEqual({
      ok: false,
      reason: "installed-exclusive",
      heldBy: undefined,
    });
    // Stock, not the installed plugin: exclusive slots are project-scope only.
    expect(ownerOf("p1")).toBeNull();
    expect(getProjectSurfaceRefusals("p1")).toEqual([
      { slot: "emptyCanvas", pluginId: "acme.dash", reason: "installed-exclusive" },
    ]);
  });

  it("refuses a claim whose kind the slot does not take", () => {
    const data: ProjectSurfaceSlotClaim = {
      pluginId: acme.pluginId,
      scope: "project",
      value: { kind: "data", data: { layout: [] } },
    };
    expect(claimProjectSurface("p1", "emptyCanvas", data)).toEqual({
      ok: false,
      reason: "claim-kind",
    });
    expect(ownerOf("p1")).toBeNull();
    expect(getProjectSurfaceRefusals("p1")).toEqual([
      { slot: "emptyCanvas", pluginId: acme.pluginId, reason: "claim-kind" },
    ]);
    // A corrected claim from the same plugin clears the refusal.
    expect(claimProjectSurface("p1", "emptyCanvas", acme)).toEqual({ ok: true });
    expect(getProjectSurfaceRefusals("p1")).toEqual([]);
  });

  it("records a view that registered nothing mountable as a refusal", () => {
    claimProjectSurface("p1", "emptyCanvas", other);
    refuseProjectSurface("p1", "emptyCanvas", acme.pluginId, "unresolved-view");
    // An unresolvable claim must not hold the slot against a working one.
    expect(ownerOf("p1")).toBe(other.pluginId);
    expect(getProjectSurfaceRefusals("p1")).toEqual([
      { slot: "emptyCanvas", pluginId: acme.pluginId, reason: "unresolved-view" },
    ]);
    expect(releasePluginSurfaces(acme.pluginId)).toEqual(["p1"]);
    expect(getProjectSurfaceRefusals("p1")).toEqual([]);
  });

  it("returns nothing for an unresolved project rather than guessing one", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    expect(getProjectSurfaceSlots(null)).toEqual({});
    expect(getProjectSurfaceSlots(undefined)).toEqual({});
    // A blank id matches no project rather than every one — fail closed.
    expect(getProjectSurfaceSlots("")).toEqual({});
  });

  it("refuses a claim with a blank project id", () => {
    expect(() => claimProjectSurface("", "emptyCanvas", acme)).toThrow(TypeError);
  });

  it("copies claims in and hands back a detached snapshot", () => {
    const mutable = view(acme.pluginId, "project:p1/acme.dash/overview");
    claimProjectSurface("p1", "emptyCanvas", mutable);
    if (mutable.value.kind === "view") mutable.value.panelKindId = "tampered";
    const snapshot = getProjectSurfaceSlots("p1");
    snapshot.emptyCanvas?.options.pop();
    expect(getProjectSurfaceSlots("p1").emptyCanvas?.options).toEqual([acme]);
  });

  it("bumps a project's revision on every change and never repeats it", () => {
    expect(getProjectSurfaceRevision("p1")).toBe(0);
    claimProjectSurface("p1", "emptyCanvas", acme);
    const afterClaim = getProjectSurfaceRevision("p1");
    expect(afterClaim).toBeGreaterThan(0);

    releasePluginSurfaces(acme.pluginId);
    const afterRelease = getProjectSurfaceRevision("p1");
    expect(afterRelease).toBeGreaterThan(afterClaim);

    // Kept once the last claim is gone, so a view never sees it go backwards.
    expect(bumpProjectSurfaceRevision("p1")).toBeGreaterThan(afterRelease);
    expect(getProjectSurfaceRevision("p2")).toBe(0);
  });
});

describe("arbitrateProjectSurfaceSlot", () => {
  const installedB: ProjectSurfaceSlotClaim = {
    pluginId: "b.side",
    scope: "installed",
    value: { kind: "view", viewId: "side" },
  };
  const projectZ: ProjectSurfaceSlotClaim = {
    pluginId: "project__p1__z.side",
    scope: "project",
    value: { kind: "view", viewId: "side" },
  };
  const projectA: ProjectSurfaceSlotClaim = {
    pluginId: "project__p1__a.side",
    scope: "project",
    value: { kind: "view", viewId: "side" },
  };

  const orders = [
    [installedB, projectZ, projectA],
    [projectA, installedB, projectZ],
    [projectZ, projectA, installedB],
  ];

  it("ranks project claims first, then by manifest id, in any arrival order", () => {
    const states = orders.map((claims) =>
      arbitrateProjectSurfaceSlot("emptyCanvas", "selectable", claims)
    );
    for (const state of states) {
      expect(state.options.map((option) => option.pluginId)).toEqual([
        projectA.pluginId,
        projectZ.pluginId,
        installedB.pluginId,
      ]);
    }
  });

  it("offers every claim on a selectable slot but defaults only to a project plugin", () => {
    const state = arbitrateProjectSurfaceSlot("emptyCanvas", "selectable", [installedB, projectZ]);
    expect(state.defaultOptionId).toBe(projectZ.pluginId);
    expect(state.refused).toEqual([]);
  });

  it("leaves a selectable slot on stock when only installed plugins offer options", () => {
    const state = arbitrateProjectSurfaceSlot("emptyCanvas", "selectable", [installedB]);
    expect(state.options).toEqual([installedB]);
    expect(state.defaultOptionId).toBeNull();
  });

  it("breaks a manifest-id tie between a project and an installed plugin by scope", () => {
    const installedSame: ProjectSurfaceSlotClaim = { ...installedB, pluginId: "a.side" };
    const state = arbitrateProjectSurfaceSlot("emptyCanvas", "selectable", [
      installedSame,
      projectA,
    ]);
    expect(state.options.map((option) => option.pluginId)).toEqual([
      projectA.pluginId,
      installedSame.pluginId,
    ]);
  });

  it("gives an exclusive slot to the top project claim and refuses the rest by name", () => {
    for (const claims of orders) {
      expect(arbitrateProjectSurfaceSlot("emptyCanvas", "exclusive", claims)).toEqual({
        mode: "exclusive",
        options: [projectA],
        defaultOptionId: projectA.pluginId,
        refused: [
          {
            slot: "emptyCanvas",
            pluginId: projectZ.pluginId,
            reason: "outranked",
            heldBy: projectA.pluginId,
          },
          { slot: "emptyCanvas", pluginId: installedB.pluginId, reason: "installed-exclusive" },
        ],
      });
    }
  });

  it("leaves an unclaimed slot on stock", () => {
    expect(arbitrateProjectSurfaceSlot("emptyCanvas", "exclusive", [])).toEqual({
      mode: "exclusive",
      options: [],
      defaultOptionId: null,
      refused: [],
    });
  });
});

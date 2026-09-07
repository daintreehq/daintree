import { beforeEach, describe, expect, it } from "vitest";
import {
  claimProjectSurface,
  clearAllProjectSurfaces,
  getProjectSurfaces,
  releasePluginSurfaces,
} from "../PluginSurfaceRegistry.js";

const acme = { pluginId: "project__p1__acme.dash", panelKindId: "project:p1/acme.dash/overview" };
const other = { pluginId: "project__p1__other.dash", panelKindId: "project:p1/other.dash/home" };

beforeEach(() => {
  clearAllProjectSurfaces();
});

describe("project surface claims (§7.8)", () => {
  it("records a claim against its project only", () => {
    expect(claimProjectSurface("p1", "emptyCanvas", acme)).toEqual({ ok: true });
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: acme });
    // The whole point of the registry being project-keyed: a second project
    // sees nothing, so its canvas is the host's own.
    expect(getProjectSurfaces("p2")).toEqual({});
  });

  it("refuses a second plugin for the same slot and names the incumbent", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    const result = claimProjectSurface("p1", "emptyCanvas", other);
    expect(result).toEqual({ ok: false, heldBy: acme.pluginId });
    // First claim stands — never a silent last-wins, which would make the
    // rendered surface a function of directory-scan order.
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: acme });
  });

  it("lets the same plugin re-claim its own slot", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    const moved = { ...acme, panelKindId: "project:p1/acme.dash/overview-v2" };
    expect(claimProjectSurface("p1", "emptyCanvas", moved)).toEqual({ ok: true });
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: moved });
  });

  it("lets two projects claim the same slot independently", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    expect(claimProjectSurface("p2", "emptyCanvas", other)).toEqual({ ok: true });
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: acme });
    expect(getProjectSurfaces("p2")).toEqual({ emptyCanvas: other });
  });

  it("releases a plugin's claims and reports the projects it touched", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p2", "emptyCanvas", { ...acme, panelKindId: "project:p2/acme.dash/o" });
    expect(releasePluginSurfaces(acme.pluginId).sort()).toEqual(["p1", "p2"]);
    expect(getProjectSurfaces("p1")).toEqual({});
    expect(getProjectSurfaces("p2")).toEqual({});
  });

  it("promotes the refused claimant when the owner unloads", () => {
    // Nothing rescans a plugin that is already loaded, so without this the slot
    // would revert to stock for the life of the app even though a valid,
    // still-loaded claimant is sitting right there.
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);

    expect(releasePluginSurfaces(acme.pluginId)).toEqual(["p1"]);
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: other });
  });

  it("reports nothing when a queued claimant unloads", () => {
    // The visible owner did not change, so no view needs a fresh snapshot.
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);

    expect(releasePluginSurfaces(other.pluginId)).toEqual([]);
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: acme });
  });

  it("keeps a queued claimant's place across its own reload", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);
    const reloaded = { ...other, panelKindId: "project:p1/other.dash/home-v2" };
    expect(claimProjectSurface("p1", "emptyCanvas", reloaded)).toEqual({
      ok: false,
      heldBy: acme.pluginId,
    });

    releasePluginSurfaces(acme.pluginId);
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: reloaded });
  });

  it("frees the slot for the next claimant after a release", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    releasePluginSurfaces(acme.pluginId);
    expect(claimProjectSurface("p1", "emptyCanvas", other)).toEqual({ ok: true });
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: other });
  });

  it("does not let a refused claimant's unload steal the incumbent's slot", () => {
    // The refused plugin never owned the slot. Unloading it must leave the
    // incumbent's surface standing, or a second plugin could remove the first's
    // surface just by loading and unloading.
    claimProjectSurface("p1", "emptyCanvas", acme);
    claimProjectSurface("p1", "emptyCanvas", other);
    releasePluginSurfaces(other.pluginId);
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: acme });
  });

  it("is idempotent on release", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    releasePluginSurfaces(acme.pluginId);
    expect(releasePluginSurfaces(acme.pluginId)).toEqual([]);
    expect(getProjectSurfaces("p1")).toEqual({});
  });

  it("returns nothing for an unresolved project rather than guessing one", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    expect(getProjectSurfaces(null)).toEqual({});
    expect(getProjectSurfaces(undefined)).toEqual({});
    // A blank id matches no project rather than every one — fail closed.
    expect(getProjectSurfaces("")).toEqual({});
  });

  it("refuses a claim with a blank project id", () => {
    expect(() => claimProjectSurface("", "emptyCanvas", acme)).toThrow(TypeError);
  });

  it("hands back a detached snapshot", () => {
    claimProjectSurface("p1", "emptyCanvas", acme);
    const snapshot = getProjectSurfaces("p1");
    delete snapshot.emptyCanvas;
    expect(getProjectSurfaces("p1")).toEqual({ emptyCanvas: acme });
  });
});

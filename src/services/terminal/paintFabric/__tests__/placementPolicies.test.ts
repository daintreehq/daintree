import { describe, expect, it } from "vitest";
import { PaintSurfaceRegistry } from "../PaintSurfaceRegistry";
import type { TerminalPaintPlane } from "../../TerminalInstanceService";
import {
  atlasKeyFor,
  computeBoundedSurfaceCount,
  createAtlasClusteringPlacement,
  createBoundedKScheduler,
  createRoundRobinPlacement,
  leastLoadedPlacement,
  mostLoadedPlacement,
} from "../placementPolicies";

function makeRegistry(ids: string[]): PaintSurfaceRegistry {
  const registry = new PaintSurfaceRegistry();
  ids.forEach((id, index) =>
    registry.registerSurface({ id, plane: {} as TerminalPaintPlane }, { isDefault: index === 0 })
  );
  return registry;
}

describe("placementPolicies", () => {
  it("round-robin cycles surfaces in registration order", () => {
    const registry = makeRegistry(["a", "b", "c"]);
    const policy = createRoundRobinPlacement();
    const picks = ["t1", "t2", "t3", "t4"].map((id) => policy(id, registry).id);
    expect(picks).toEqual(["a", "b", "c", "a"]);
  });

  it("least/most-loaded read live placement counts", () => {
    const registry = makeRegistry(["a", "b"]);
    registry.place("t1", "a");
    registry.place("t2", "a");
    registry.place("t3", "b");
    expect(leastLoadedPlacement("tx", registry).id).toBe("b");
    expect(mostLoadedPlacement("tx", registry).id).toBe("a");
  });

  it("atlas clustering keys on font + size + theme", () => {
    const dark = { background: "#000", foreground: "#fff" };
    const light = { background: "#fff", foreground: "#000" };
    expect(atlasKeyFor({ options: { fontFamily: "Menlo", fontSize: 13, theme: dark } })).toBe(
      atlasKeyFor({ options: { fontFamily: "Menlo", fontSize: 13, theme: dark } })
    );
    expect(atlasKeyFor({ options: { fontFamily: "Menlo", fontSize: 13, theme: dark } })).not.toBe(
      atlasKeyFor({ options: { fontFamily: "Menlo", fontSize: 13, theme: light } })
    );
    expect(atlasKeyFor({ options: { fontFamily: "Menlo" } })).not.toBe(
      atlasKeyFor({ options: { fontFamily: "Hack" } })
    );
    expect(atlasKeyFor(undefined)).toBe("default");
  });

  it("atlas clustering keeps same-key terminals on one surface and re-chooses after unregister", () => {
    const registry = makeRegistry(["a", "b"]);
    const policy = createAtlasClusteringPlacement();
    const menlo = { options: { fontFamily: "Menlo" } };
    const hack = { options: { fontFamily: "Hack" } };

    const first = policy("t1", registry, menlo);
    registry.place("t1", first.id);
    const second = policy("t2", registry, menlo);
    expect(second.id).toBe(first.id);
    registry.place("t2", second.id);

    // Different atlas key → least-loaded lands on the other surface.
    const third = policy("t3", registry, hack);
    expect(third.id).not.toBe(first.id);
    registry.place("t3", third.id);

    // The sticky surface disappears → the key re-chooses among survivors.
    const registry2 = makeRegistry(["a", "b"]);
    const policy2 = createAtlasClusteringPlacement();
    const sticky = policy2("t1", registry2, menlo);
    registry2.place("t1", sticky.id);
    if (sticky.id !== "a") {
      registry2.unregisterSurface(sticky.id);
      const rehomed = policy2("t2", registry2, menlo);
      expect(rehomed.id).toBe("a");
    }
  });

  it("bounded-K scheduler sends hot terminals to the emptiest surface and packs cold ones", () => {
    const registry = makeRegistry(["a", "b"]);
    registry.place("t1", "a");
    const scheduler = createBoundedKScheduler();

    // Hot (has a launch agent) → least loaded.
    expect(scheduler("hot-1", registry, { launchAgentId: "claude" }).id).toBe("b");
    // Cold (plain shell) → packed onto the most loaded.
    expect(scheduler("cold-1", registry, {}).id).toBe("a");
  });

  it("bounds surface count by cores, memory, and the hard cap", () => {
    expect(computeBoundedSurfaceCount({ cpuCores: 16, deviceMemoryGb: 32, maxSurfaces: 4 })).toBe(
      4
    );
    expect(computeBoundedSurfaceCount({ cpuCores: 8, deviceMemoryGb: 32, maxSurfaces: 4 })).toBe(2);
    expect(computeBoundedSurfaceCount({ cpuCores: 16, deviceMemoryGb: 8, maxSurfaces: 4 })).toBe(2);
    // Never below one surface, however small the machine.
    expect(computeBoundedSurfaceCount({ cpuCores: 2, deviceMemoryGb: 2, maxSurfaces: 4 })).toBe(1);
  });
});

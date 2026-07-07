import { describe, expect, it } from "vitest";
import { PaintSurfaceRegistry } from "../PaintSurfaceRegistry";
import type { TerminalPaintPlane } from "../../TerminalInstanceService";
import { createRoundRobinPlacement, leastLoadedPlacement } from "../placementPolicies";

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

  it("least-loaded reads live placement counts", () => {
    const registry = makeRegistry(["a", "b"]);
    registry.place("t1", "a");
    registry.place("t2", "a");
    registry.place("t3", "b");
    expect(leastLoadedPlacement("tx", registry).id).toBe("b");
  });
});

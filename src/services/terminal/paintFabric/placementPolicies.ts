import type { Terminal } from "@xterm/xterm";
import type { PaintSurface, PaintSurfaceRegistry } from "./PaintSurfaceRegistry";

// What the compositor knows about a terminal at claim time. Policies use it
// to cluster (atlas key from font/theme) and to schedule (hot/cold from the
// launch agent); everything is optional so a policy degrades to naive
// placement when a creation path (prewarm) carries less context.
export interface PlacementContext {
  launchAgentId?: string;
  options?: ConstructorParameters<typeof Terminal>[0];
}

export type PlacementPolicy = (
  terminalId: string,
  registry: PaintSurfaceRegistry,
  context?: PlacementContext
) => PaintSurface;

export const defaultSurfacePlacement: PlacementPolicy = (_, registry) => registry.defaultSurface();

// Phase 1 naive placement: cycle surfaces in registration order. Stateful by
// design — a policy instance belongs to one compositor.
export function createRoundRobinPlacement(): PlacementPolicy {
  let next = 0;
  return (_, registry) => {
    const surfaces = registry.surfaces();
    const surface = surfaces[next % surfaces.length]!;
    next = (next + 1) % surfaces.length;
    return surface;
  };
}

export const leastLoadedPlacement: PlacementPolicy = (_, registry) => {
  let best: PaintSurface | null = null;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const surface of registry.surfaces()) {
    const count = registry.placementCount(surface.id);
    if (count < bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return best ?? registry.defaultSurface();
};

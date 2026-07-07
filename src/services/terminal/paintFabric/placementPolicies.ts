import type { Terminal } from "@xterm/xterm";
import { surfaceKind, type PaintSurface, type PaintSurfaceRegistry } from "./PaintSurfaceRegistry";

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

// The glyph-atlas identity of a terminal: xterm's WebGL addon shares one
// module-global TextureAtlas across every terminal in a view whose font and
// theme match, so co-locating same-key terminals preserves that sharing and
// keeps the #8080 page-merge hazard scoped within one surface. Terminals with
// different keys never shared an atlas anyway, so splitting them across
// surfaces costs nothing.
export function atlasKeyFor(context?: PlacementContext): string {
  const options = context?.options;
  if (!options) return "default";
  const theme = options.theme;
  const themeKey = theme ? `${theme.background ?? ""}/${theme.foreground ?? ""}` : "default-theme";
  return [options.fontFamily ?? "default-font", options.fontSize ?? "default-size", themeKey].join(
    "|"
  );
}

// Phase 2 placement: same-atlas terminals cluster on the surface that already
// hosts their atlas key; a new key is placed by `chooseForNewKey` (least
// loaded by default) and the key sticks to that surface for the compositor's
// lifetime unless the surface unregisters.
export function createAtlasClusteringPlacement(
  chooseForNewKey: PlacementPolicy = leastLoadedPlacement
): PlacementPolicy {
  const surfaceByAtlasKey = new Map<string, string>();
  return (terminalId, registry, context) => {
    const key = atlasKeyFor(context);
    const existingId = surfaceByAtlasKey.get(key);
    if (existingId !== undefined) {
      const existing = registry.surfaceById(existingId);
      if (existing) return existing;
      surfaceByAtlasKey.delete(key);
    }
    const chosen = chooseForNewKey(terminalId, registry, context);
    surfaceByAtlasKey.set(key, chosen.id);
    return chosen;
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

// Phase 5 scheduler: hot terminals (an agent is attached — the terminals that
// stream and repaint hardest) get the emptiest surface so a busy agent tends
// toward a dedicated parse/paint budget; cold plain shells pack onto the most
// loaded surface to keep surfaces free for future hot arrivals. Composes with
// Phase 2: pass an atlas-clustering policy as `packCold` to keep cold packing
// atlas-coherent.
export function createBoundedKScheduler(
  options: {
    isHot?: (terminalId: string, context?: PlacementContext) => boolean;
    packCold?: PlacementPolicy;
  } = {}
): PlacementPolicy {
  const isHot = options.isHot ?? ((_, context) => context?.launchAgentId !== undefined);
  const packCold = options.packCold ?? mostLoadedPlacement;
  return (terminalId, registry, context) => {
    if (isHot(terminalId, context)) {
      return leastLoadedPlacement(terminalId, registry, context);
    }
    return packCold(terminalId, registry, context);
  };
}

// Phase 1V geometry constraint: a view-hosted surface owns a rectangular
// window region exclusively (no per-pixel input pass-through between stacked
// views), so it can only host a terminal whose grid pane lies inside a band
// the surface owns. Local surfaces are always hostable — they share the
// window's DOM. Wraps any inner policy: an inner choice that violates the
// constraint falls back to the least-loaded hostable surface, degrading to
// the default surface (always local today) so placement never fails.
//
// Composition caveat for STATEFUL inner policies (atlas clustering): the
// inner policy commits its sticky state (atlas key → surface) before this
// wrapper can veto the choice, so wrap the clustering policy's
// `chooseForNewKey` with the geometry constraint instead of wrapping the
// clustering policy itself — otherwise a vetoed pick still records the
// unhostable surface for the key.
export function createGeometryConstrainedPlacement(
  inner: PlacementPolicy,
  canHost: (surfaceId: string, terminalId: string, context?: PlacementContext) => boolean
): PlacementPolicy {
  return (terminalId, registry, context) => {
    const hostable = (surface: PaintSurface): boolean =>
      surfaceKind(surface) === "local" || canHost(surface.id, terminalId, context);
    const chosen = inner(terminalId, registry, context);
    if (hostable(chosen)) return chosen;
    let best: PaintSurface | null = null;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const surface of registry.surfaces()) {
      if (!hostable(surface)) continue;
      const count = registry.placementCount(surface.id);
      if (count < bestCount) {
        best = surface;
        bestCount = count;
      }
    }
    return best ?? registry.defaultSurface();
  };
}

export const mostLoadedPlacement: PlacementPolicy = (_, registry) => {
  let best: PaintSurface | null = null;
  let bestCount = -1;
  for (const surface of registry.surfaces()) {
    const count = registry.placementCount(surface.id);
    if (count > bestCount) {
      best = surface;
      bestCount = count;
    }
  }
  return best ?? registry.defaultSurface();
};

// Phase 5 surface-count bound: surfaces cost a renderer heap and a duplicated
// atlas each, so the cap comes from the machine, not the terminal count. One
// surface per ~4 cores keeps parse shards meaningful; one per ~4 GB device
// memory respects the #10498 memory ceiling the fabric must not regress.
export function computeBoundedSurfaceCount(hardware: {
  cpuCores: number;
  deviceMemoryGb: number;
  maxSurfaces: number;
}): number {
  const byCores = Math.floor(hardware.cpuCores / 4);
  const byMemory = Math.floor(hardware.deviceMemoryGb / 4);
  return Math.max(1, Math.min(byCores, byMemory, hardware.maxSurfaces));
}

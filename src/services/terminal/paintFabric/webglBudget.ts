// Phase 2 of the paint fabric: the aggregate GPU-context governor.
//
// Each render surface honestly owns a 16-context budget (Chromium's cap is
// per renderer process), but the machine's GPU memory is shared — K surfaces
// each independently packing to 12 contexts would put 12·K live contexts on
// one GPU. The compositor therefore owns a machine-level ceiling and
// distributes it across surfaces by demand (waterfill): every surface gets up
// to its fair share, surfaces that want less donate the remainder, and no
// surface ever exceeds the per-view safe threshold the single-surface tuning
// established.
//
// Pure logic, no I/O: in-process surfaces share one renderer (and one
// module-global threshold pair), so applying diverging budgets only becomes
// meaningful when surfaces are hosted by sibling WebContentsViews — at which
// point the apply step is an IPC push of `setWebglThresholds(upper, lower)`
// into each surface view. Keeping the arithmetic here, tested, means the view
// host lands against a proven allocator instead of inventing one under
// pressure.

// Mirrors the hysteresis gap between the single-surface defaults
// (upper 12 / lower 10, TerminalWebGLConfig.ts) so per-surface mode flips
// keep today's anti-flap behavior.
export const WEBGL_BUDGET_HYSTERESIS_GAP = 2;

// The per-view threshold the single-surface path runs at: comfortably under
// Chromium's 16 to leave headroom for devtools and non-terminal WebGL.
export const PER_SURFACE_WEBGL_MAX = 12;

// Default machine-level ceiling on total live terminal WebGL contexts across
// all of a project's surfaces. Deliberately conservative: two surfaces' worth
// of the single-view budget. The resource profiler can lower it under memory
// pressure the same way it lowers the single-view thresholds today.
export const DEFAULT_MACHINE_CONTEXT_CEILING = 24;

export interface SurfaceWebglDemand {
  surfaceId: string;
  // How many terminals on this surface currently want a WebGL context
  // (TerminalWebGLManager.getWantsSize()).
  wants: number;
}

export interface SurfaceWebglBudget {
  surfaceId: string;
  upperThreshold: number;
  lowerThreshold: number;
}

/**
 * Waterfill the machine ceiling across surfaces by demand. Deterministic:
 * ties resolve in input order. Every surface receives at least 1 slot (a
 * budget of 0 would flip it to DOM permanently regardless of demand, which
 * is the whole-project degradation the fabric exists to prevent) and at most
 * PER_SURFACE_WEBGL_MAX.
 */
export function distributeWebglBudget(
  demands: SurfaceWebglDemand[],
  machineCeiling: number = DEFAULT_MACHINE_CONTEXT_CEILING
): SurfaceWebglBudget[] {
  if (demands.length === 0) return [];

  const grants = new Map<string, number>();
  demands.forEach((demand) => grants.set(demand.surfaceId, 1));
  let remaining = machineCeiling - demands.length;

  // Rounds of +1 grants to surfaces still under both their demand and the
  // per-surface max, until the ceiling or all demand is exhausted. Demand
  // below 1 still holds the floor grant — an idle surface keeps one slot so
  // its first hot terminal doesn't boot into DOM mode.
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (const demand of demands) {
      if (remaining <= 0) break;
      const current = grants.get(demand.surfaceId)!;
      if (current >= PER_SURFACE_WEBGL_MAX) continue;
      if (current >= Math.max(demand.wants, 1)) continue;
      grants.set(demand.surfaceId, current + 1);
      remaining -= 1;
      progressed = true;
    }
  }

  return demands.map((demand) => {
    const upper = grants.get(demand.surfaceId)!;
    return {
      surfaceId: demand.surfaceId,
      upperThreshold: upper,
      lowerThreshold: Math.max(0, upper - WEBGL_BUDGET_HYSTERESIS_GAP),
    };
  });
}

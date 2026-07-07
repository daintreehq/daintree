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
 * ties resolve in input order. Surfaces receive a floor of 1 slot in input
 * order while the ceiling allows (a budget of 0 flips a surface to DOM
 * permanently regardless of demand), at most PER_SURFACE_WEBGL_MAX each, and
 * the ceiling is a hard total — a ceiling below the surface count zeroes the
 * tail rather than exceeding it.
 */
export function distributeWebglBudget(
  demands: SurfaceWebglDemand[],
  machineCeiling: number = DEFAULT_MACHINE_CONTEXT_CEILING
): SurfaceWebglBudget[] {
  if (demands.length === 0) return [];

  const grants = new Map<string, number>();
  let remaining = machineCeiling;
  for (const demand of demands) {
    const floor = remaining > 0 ? 1 : 0;
    grants.set(demand.surfaceId, floor);
    remaining -= floor;
  }

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

export interface WebglBudgetApplyResult {
  applied: SurfaceWebglBudget[];
  failed: Array<{ surfaceId: string; error: unknown }>;
}

export interface WebglBudgetApplier {
  apply(budgets: SurfaceWebglBudget[]): Promise<WebglBudgetApplyResult>;
  // A retired surface's memo must drop so a re-created surface with the same
  // id gets a fresh push instead of being deduped against a dead view.
  forget(surfaceId: string): void;
}

/**
 * The Phase 1V apply step: pushes each surface's granted thresholds through
 * the injected transport (an IPC call into the surface's WebContentsView,
 * where the surface-side TerminalWebGLManager applies them). Deduplicates
 * against the last successfully-applied values so a recompute that grants the
 * same budget costs no IPC, and isolates failures per surface — one dead view
 * never blocks its siblings' budgets. Failed pushes are not memoized, so the
 * next apply retries them.
 */
export function createWebglBudgetApplier(
  push: (budget: SurfaceWebglBudget) => Promise<void> | void
): WebglBudgetApplier {
  const lastApplied = new Map<string, string>();
  return {
    async apply(budgets: SurfaceWebglBudget[]): Promise<WebglBudgetApplyResult> {
      const applied: SurfaceWebglBudget[] = [];
      const failed: Array<{ surfaceId: string; error: unknown }> = [];
      for (const budget of budgets) {
        const key = `${budget.upperThreshold}/${budget.lowerThreshold}`;
        if (lastApplied.get(budget.surfaceId) === key) continue;
        try {
          await push(budget);
        } catch (error) {
          failed.push({ surfaceId: budget.surfaceId, error });
          continue;
        }
        lastApplied.set(budget.surfaceId, key);
        applied.push(budget);
      }
      return { applied, failed };
    },
    forget(surfaceId: string): void {
      lastApplied.delete(surfaceId);
    },
  };
}

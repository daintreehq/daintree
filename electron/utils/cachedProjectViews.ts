import os from "node:os";
import { getIsE2EMode } from "../setup/runtimeFlags.js";

const GIB = 1024 ** 3;

export function computeDefaultCachedViews(totalMemBytes: number): number {
  // The cap counts the active view, so N means N-1 warm background views.
  // Frozen+invisible cached renderers (setVisible(false) releases their GPU
  // tile textures) are cheap enough to keep more around, and evictStaleViews()
  // still drops to 1 when free RAM is genuinely low — so a higher default keeps
  // rapid project switching warm without unbounded memory growth. The tiers
  // scale with RAM so capable machines keep a realistic rotation hot: a cold
  // start reloads a renderer (~100–500 MB) and reads as a multi-hundred-ms
  // pause, whereas a cached "warm swap" reveals in ~60 ms, so every extra warm
  // view converts a cold switch into an instant one. Capped at the cache
  // ceiling (5) honored by isValidCachedProjectViews / setCachedViewLimit.
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 2;
  if (totalMemBytes >= 64 * GIB) return 5;
  if (totalMemBytes >= 32 * GIB) return 4;
  if (totalMemBytes >= 16 * GIB) return 3;
  return 2;
}

export function isValidCachedProjectViews(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

export interface EffectiveCachedProjectViewsOptions {
  totalMemBytes?: number;
  isE2E?: boolean;
}

export function effectiveCachedProjectViews(
  stored: unknown,
  opts: EffectiveCachedProjectViewsOptions = {}
): number {
  if (isValidCachedProjectViews(stored)) return stored;
  const isE2E = opts.isE2E ?? getIsE2EMode();
  if (isE2E) return 4;
  const totalMemBytes = opts.totalMemBytes ?? os.totalmem();
  return computeDefaultCachedViews(totalMemBytes);
}

/**
 * Available-memory band that governs cached-view reclaim. Both edges come from
 * `getSystemMemoryThresholds()` and are pushed as a pair, so the ladder never
 * has to infer one edge from the other (#11469). The legacy single-scalar
 * setter maps to `criticalMb === warningMb`, which collapses the band to the
 * pre-#11469 cliff.
 */
export interface MemoryPressurePolicy {
  criticalMb: number;
  warningMb: number;
}

export type MemoryPressureLevel = "none" | "soft" | "critical";

export interface MemoryPressureTarget {
  level: MemoryPressureLevel;
  targetMax: number;
}

/**
 * Settled cached-view cap implied by available memory — the target a pass
 * converges toward, NOT how many views one pass may destroy (that is the
 * caller's per-pass budget).
 *
 * Above `warningMb` the user's configured cap stands. Below `criticalMb` the
 * cache collapses to the active view alone, matching the pre-#11469 cliff at
 * exactly the point it used to fire. Between them the cap steps down one view
 * per equal slice of the band, so reclaim begins a full band-width earlier and
 * degrades warm switching gradually instead of destroying the whole cache in
 * one pass.
 *
 * `< criticalMb` is deliberately strict, preserving the boundary rule the
 * previous single-threshold check used.
 */
export function memoryPressureTarget(
  availableMb: number,
  policy: MemoryPressurePolicy,
  maxCachedViews: number
): MemoryPressureTarget {
  // Normalized rather than trusted: the return value caps a view count, so a
  // fractional or non-finite input must not leak out as a fractional target.
  const cap = Number.isFinite(maxCachedViews) ? Math.max(1, Math.floor(maxCachedViews)) : 1;
  if (!Number.isFinite(availableMb)) return { level: "none", targetMax: cap };
  if (availableMb < policy.criticalMb) return { level: "critical", targetMax: 1 };
  if (availableMb >= policy.warningMb) return { level: "none", targetMax: cap };
  // A degenerate band (legacy cliff, or an inverted pair) has no room to step
  // through — the two branches above already classified every reading.
  if (cap <= 1 || policy.warningMb <= policy.criticalMb) {
    return { level: "soft", targetMax: 1 };
  }
  const stepMb = (policy.warningMb - policy.criticalMb) / (cap - 1);
  const steps = Math.floor((availableMb - policy.criticalMb) / stepMb);
  // Clamped for float safety: the band bounds already imply [1, cap - 1].
  const targetMax = Math.min(Math.max(1 + steps, 1), cap - 1);
  return { level: "soft", targetMax };
}

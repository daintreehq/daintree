import os from "node:os";
import { getIsE2EMode } from "../setup/runtimeFlags.js";

const GIB = 1024 ** 3;

export function computeDefaultCachedViews(totalMemBytes: number): number {
  // The cap counts the active view, so N means N-1 warm background views.
  // Frozen+invisible cached renderers (setVisible(false) releases their GPU
  // tile textures) are cheap enough to keep more around, and evictStaleViews()
  // still drops to 1 when free RAM is genuinely low — so a higher default keeps
  // rapid project switching warm without unbounded memory growth.
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 2;
  if (totalMemBytes >= 64 * GIB) return 4;
  if (totalMemBytes >= 32 * GIB) return 3;
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

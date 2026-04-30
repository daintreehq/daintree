import os from "node:os";

const GIB = 1024 ** 3;

export function computeDefaultCachedViews(totalMemBytes: number): number {
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 1;
  if (totalMemBytes >= 64 * GIB) return 3;
  if (totalMemBytes >= 32 * GIB) return 2;
  return 1;
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
  const isE2E = opts.isE2E ?? process.env.DAINTREE_E2E_MODE === "1";
  if (isE2E) return 4;
  const totalMemBytes = opts.totalMemBytes ?? os.totalmem();
  return computeDefaultCachedViews(totalMemBytes);
}

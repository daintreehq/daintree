import type { RiskBand } from "../types/actions.js";

export const RISK_BAND_OPEN_WORLD_CATEGORIES: ReadonlySet<string> = new Set([
  "browser",
  "devServer",
  "github",
  "portal",
  "voice",
  "system",
]);

/**
 * Per-action band overrides for cases where the mechanical derivation from
 * `danger` + open-world category doesn't capture the action's true semantics.
 */
export const BAND_OVERRIDES: Readonly<Record<string, RiskBand>> = {
  "git.push": "external-effect",
  "copyTree.generateAndCopyFile": "destructive-local",
};

/**
 * Derive a risk band from danger + category. Checks {@link BAND_OVERRIDES}
 * first, then falls back to the mechanical derivation from the two axes
 * already used by `buildAnnotations` in tierAuth.ts.
 */
export function deriveBand(entry: { id?: string; danger: string; category: string }): RiskBand {
  if (entry.id) {
    const override = BAND_OVERRIDES[entry.id];
    if (override) return override;
  }
  const isOpenWorld = RISK_BAND_OPEN_WORLD_CATEGORIES.has(entry.category);
  if (entry.danger === "confirm" && isOpenWorld) return "destructive-network";
  if (entry.danger === "confirm") return "destructive-local";
  if (isOpenWorld) return "external-effect";
  return "reversible";
}

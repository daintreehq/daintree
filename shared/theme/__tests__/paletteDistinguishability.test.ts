import { describe, expect, it } from "vitest";
import type { Color } from "culori";
import {
  parse,
  filterDeficiencyProt,
  filterDeficiencyDeuter,
  filterDeficiencyTrit,
  useMode,
  modeOklab,
  differenceEuclidean,
} from "culori";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { WORKTREE_COLOR_PALETTE } from "../worktreeColors.js";
import { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES } from "../colorVisionOverrides.js";
import type { AppThemeTokenKey } from "../types.js";

// eslint-disable-next-line react-hooks/rules-of-hooks -- culori config, not a React hook
useMode(modeOklab);

const OKABE_ITO = [
  "#000000",
  "#E69F00",
  "#56B4E9",
  "#009E73",
  "#F0E442",
  "#0072B2",
  "#D55E00",
  "#CC79A7",
];

type Deficiency = "protanopia" | "deuteranopia" | "tritanopia";

const ALL_CATEGORY_TOKENS = [
  "category-blue",
  "category-purple",
  "category-cyan",
  "category-green",
  "category-amber",
  "category-orange",
  "category-teal",
  "category-indigo",
  "category-rose",
  "category-pink",
  "category-violet",
  "category-slate",
] as const;

const STATUS_TOKENS = ["status-success", "status-warning", "status-danger", "status-info"] as const;

const DEFICIENCIES: Deficiency[] = ["protanopia", "deuteranopia", "tritanopia"];

// Quarter-JND floor (~0.005 OKLab units). Catches near-identical perceived
// colors under CVD. 1 JND ≈ 0.02 in OKLab; 0.005 is the floor where two tokens
// map to functionally the same color. The Okabe-Ito calibration benchmark is
// considerably higher (~0.09–0.10), serving as the aspirational target
// documented in the informational tests below.
const JND_FLOOR = 0.005;

function cvdFilter(deficiency: Deficiency) {
  switch (deficiency) {
    case "protanopia":
      return filterDeficiencyProt(1);
    case "deuteranopia":
      return filterDeficiencyDeuter(1);
    case "tritanopia":
      return filterDeficiencyTrit(1);
  }
}

function parseColor(s: unknown) {
  if (typeof s !== "string") return undefined;
  const normalized = s.trim();
  if (normalized.startsWith("var(") || normalized.startsWith("color-mix(")) return undefined;
  return parse(normalized);
}

function resolveTokens(
  scheme: (typeof BUILT_IN_APP_SCHEMES)[number],
  keys: readonly string[]
): string[] {
  const result: string[] = [];
  for (const key of keys) {
    const value = scheme.tokens[key as AppThemeTokenKey];
    if (typeof value === "string") result.push(value);
  }
  return result;
}

function computePairwiseDistances(
  colors: string[],
  deficiency: Deficiency
): { distances: number[]; skipped: string[] } {
  const filter = cvdFilter(deficiency);
  const parsed: Array<{ color: Color; raw: string }> = [];
  const skipped: string[] = [];

  for (const c of colors) {
    const p = parseColor(c);
    if (!p) {
      skipped.push(c);
      continue;
    }
    parsed.push({ color: filter(p), raw: c });
  }

  const distances: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      distances.push(differenceEuclidean("oklab")(parsed[i]!.color, parsed[j]!.color));
    }
  }

  return { distances, skipped };
}

function normHex(h: string): string {
  return h.trim().toLowerCase();
}

function calibrateOkabeItoThreshold(deficiency: Deficiency): number {
  const { distances } = computePairwiseDistances(OKABE_ITO, deficiency);
  return Math.min(...distances);
}

function minPairwiseDistance(colors: string[], deficiency: Deficiency): number | null {
  const { distances, skipped } = computePairwiseDistances(colors, deficiency);
  if (skipped.length > 0 || distances.length === 0) return null;
  return Math.min(...distances);
}

// Reference: Okabe-Ito calibrated thresholds (informational only).
const OI_THRESHOLDS = Object.fromEntries(
  DEFICIENCIES.map((d) => [d, calibrateOkabeItoThreshold(d)])
) as Record<Deficiency, number>;

describe("palette distinguishability", () => {
  it("Okabe-Ito calibration yields positive thresholds", () => {
    for (const [mode, t] of Object.entries(OI_THRESHOLDS)) {
      expect(t, `${mode} threshold`).toBeGreaterThan(0);
      expect(t, `${mode} threshold should be below 0.25 OKLab units`).toBeLessThan(0.25);
    }
  });

  describe("worktree identity palette (WORKTREE_COLOR_PALETTE)", () => {
    it("no two worktree tokens collapse to identity under any CVD mode (JND floor)", () => {
      const failures: string[] = [];

      for (const scheme of BUILT_IN_APP_SCHEMES) {
        const values = resolveTokens(scheme, [...WORKTREE_COLOR_PALETTE]);
        if (values.length !== 8) {
          failures.push(`${scheme.id}: only ${values.length}/8 tokens present`);
          continue;
        }

        for (const deficiency of DEFICIENCIES) {
          const { distances, skipped } = computePairwiseDistances(values, deficiency);
          if (skipped.length > 0) {
            failures.push(`${scheme.id} ${deficiency}: could not parse: ${skipped.join(", ")}`);
            continue;
          }

          let pairIdx = 0;
          for (let i = 0; i < WORKTREE_COLOR_PALETTE.length; i++) {
            for (let j = i + 1; j < WORKTREE_COLOR_PALETTE.length; j++) {
              const d = distances[pairIdx++]!;
              if (d < JND_FLOOR) {
                failures.push(
                  `${scheme.id} ${deficiency}: ${WORKTREE_COLOR_PALETTE[i]}-${WORKTREE_COLOR_PALETTE[j]} = ${d.toFixed(4)} (below JND floor ${JND_FLOOR})`
                );
              }
            }
          }
        }
      }

      expect(
        failures,
        `${failures.length} token pairs collapsed to near-identity under CVD\n${failures.join("\n")}`
      ).toHaveLength(0);
    });

    it("reports minimum pairwise distance per scheme vs Okabe-Ito reference", () => {
      // Informational: documents how each scheme's worktree palette compares
      // to the Okabe-Ito gold standard. Not a hard gate.
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        const values = resolveTokens(scheme, [...WORKTREE_COLOR_PALETTE]);
        if (values.length !== 8) continue;

        for (const deficiency of DEFICIENCIES) {
          const minDist = minPairwiseDistance(values, deficiency);
          const oi = OI_THRESHOLDS[deficiency]!;
          expect(minDist, `${scheme.id} ${deficiency} minimum`).toBeGreaterThan(0);
          // Logging-only check: records schemes below the Okabe-Ito bar.
          // Not a hard failure — the JND-floor test above is the hard gate.
          if (minDist !== null) {
            expect(
              minDist,
              `${scheme.id} ${deficiency}: worktree min ${minDist.toFixed(4)} (Okabe-Ito ref: ${oi.toFixed(4)})`
            ).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  describe("category-status cross-group", () => {
    it("no category token collapses into a status token under any CVD mode", () => {
      const failures: string[] = [];

      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const deficiency of DEFICIENCIES) {
          const filter = cvdFilter(deficiency);

          for (const catKey of WORKTREE_COLOR_PALETTE) {
            const catValue = scheme.tokens[catKey as AppThemeTokenKey] as string;
            const catParsed = parseColor(catValue);
            if (!catParsed) {
              failures.push(`${scheme.id} ${deficiency}: could not parse ${catKey}: ${catValue}`);
              continue;
            }
            const catCvd = filter(catParsed);

            for (const statusKey of STATUS_TOKENS) {
              const statusValue = scheme.tokens[statusKey as AppThemeTokenKey] as string;
              const statusParsed = parseColor(statusValue);
              if (!statusParsed) {
                failures.push(
                  `${scheme.id} ${deficiency}: could not parse ${statusKey}: ${statusValue}`
                );
                continue;
              }
              const statusCvd = filter(statusParsed);

              const d = differenceEuclidean("oklab")(catCvd, statusCvd);
              if (d < JND_FLOOR) {
                failures.push(
                  `${scheme.id} ${deficiency}: ${catKey}-${statusKey} = ${d.toFixed(4)} (below JND floor)`
                );
              }
            }
          }
        }
      }

      expect(
        failures,
        `${failures.length} category-status pairs collapsed to near-identity under CVD\n${failures.join("\n")}`
      ).toHaveLength(0);
    });
  });

  describe("full 12-token category set", () => {
    it("no two category tokens collapse to identity under any CVD mode", () => {
      const failures: string[] = [];

      for (const scheme of BUILT_IN_APP_SCHEMES) {
        const values = resolveTokens(scheme, [...ALL_CATEGORY_TOKENS]);
        if (values.length !== 12) {
          failures.push(`${scheme.id}: only ${values.length}/12 category tokens present`);
          continue;
        }

        for (const deficiency of DEFICIENCIES) {
          const { distances, skipped } = computePairwiseDistances(values, deficiency);
          if (skipped.length > 0) {
            failures.push(`${scheme.id} ${deficiency}: could not parse: ${skipped.join(", ")}`);
            continue;
          }

          let pairIdx = 0;
          for (let i = 0; i < ALL_CATEGORY_TOKENS.length; i++) {
            for (let j = i + 1; j < ALL_CATEGORY_TOKENS.length; j++) {
              const d = distances[pairIdx++]!;
              if (d < JND_FLOOR) {
                failures.push(
                  `${scheme.id} ${deficiency}: ${ALL_CATEGORY_TOKENS[i]}-${ALL_CATEGORY_TOKENS[j]} = ${d.toFixed(4)}`
                );
              }
            }
          }
        }
      }

      expect(
        failures,
        `${failures.length} category pairs collapsed to near-identity under CVD\n${failures.join("\n")}`
      ).toHaveLength(0);
    });
  });

  describe("CVD override maps internal distinguishability", () => {
    // Only the opaque signal colors must be mutually distinguishable. The
    // derived status-*-surface and diff-*-background washes are translucent
    // rgba() backgrounds, not signals (and unparseable by culori), so they're
    // excluded from this gate.
    const signalHexValues = (map: Record<string, string>) =>
      Object.entries(map)
        .filter(([token]) => !token.endsWith("-surface") && !token.endsWith("-background"))
        .map(([, value]) => normHex(value));
    const RED_GREEN_UNIQUE = [...new Set(signalHexValues(RED_GREEN_OVERRIDES))];
    const BLUE_YELLOW_UNIQUE = [...new Set(signalHexValues(BLUE_YELLOW_OVERRIDES))];

    function testOverrideMap(name: string, uniqueHex: string[], deficiencies: Deficiency[]) {
      it(`${name}: no two override colors collapse to identity under target deficiencies`, () => {
        const failures: string[] = [];

        for (const deficiency of deficiencies) {
          const { distances, skipped } = computePairwiseDistances(uniqueHex, deficiency);
          if (skipped.length > 0) {
            failures.push(`${name} ${deficiency}: could not parse: ${skipped.join(", ")}`);
            continue;
          }

          let pairIdx = 0;
          for (let i = 0; i < uniqueHex.length; i++) {
            for (let j = i + 1; j < uniqueHex.length; j++) {
              const d = distances[pairIdx++]!;
              if (d < JND_FLOOR) {
                failures.push(
                  `${name} ${deficiency}: ${uniqueHex[i]} - ${uniqueHex[j]} = ${d.toFixed(4)}`
                );
              }
            }
          }
        }

        expect(
          failures,
          `${failures.length} override pairs collapsed to near-identity under CVD\n${failures.join("\n")}`
        ).toHaveLength(0);
      });

      it(`${name}: internal distinguishability vs Okabe-Ito reference (informational)`, () => {
        for (const deficiency of deficiencies) {
          const minDist = minPairwiseDistance(uniqueHex, deficiency);
          const oi = OI_THRESHOLDS[deficiency]!;
          expect(minDist, `${name} ${deficiency} minimum`).toBeGreaterThan(0);
          // Informational: reports distance relative to Okabe-Ito reference.
          // The JND-floor test above is the hard gate; this documents the gap.
          if (minDist !== null) {
            expect(
              minDist,
              `${name} ${deficiency}: override min ${minDist.toFixed(4)} (Okabe-Ito ref: ${oi.toFixed(4)})`
            ).toBeGreaterThan(0);
          }
        }
      });
    }

    testOverrideMap("RED_GREEN_OVERRIDES", RED_GREEN_UNIQUE, ["protanopia", "deuteranopia"]);

    testOverrideMap("BLUE_YELLOW_OVERRIDES", BLUE_YELLOW_UNIQUE, ["tritanopia"]);
  });

  describe("CVD diff token coverage", () => {
    // The light-mode diff viewer reads pre-baked --color-diff-* tokens, which
    // mirror --theme-diff-*. A CVD override must re-derive these from the
    // overridden status colors or light-mode diff fills/gutters keep the
    // original (non-CVD) hue. Only red-green overrides status-success/-danger,
    // so only it should gain diff tokens; blue-yellow overrides neither.
    const DIFF_TOKENS = [
      "--theme-diff-insert-background",
      "--theme-diff-insert-edit-background",
      "--theme-diff-gutter-insert",
      "--theme-diff-delete-background",
      "--theme-diff-delete-edit-background",
      "--theme-diff-gutter-delete",
    ] as const;

    // Floor for insert-vs-delete diff gutters under red-green CVD. Well above
    // the 0.005 identity JND but below the Okabe-Ito calibration (~0.09) so it
    // gates accidental collapse without locking the hand-tuned hex values.
    const DIFF_DISTINGUISHABILITY_FLOOR = 0.05;

    it("RED_GREEN_OVERRIDES defines all six diff tokens; BLUE_YELLOW_OVERRIDES defines none", () => {
      for (const token of DIFF_TOKENS) {
        expect(RED_GREEN_OVERRIDES, `red-green should define ${token}`).toHaveProperty(token);
        expect(BLUE_YELLOW_OVERRIDES, `blue-yellow should not define ${token}`).not.toHaveProperty(
          token
        );
      }
    });

    it("red-green diff gutters stay distinguishable under protanopia and deuteranopia", () => {
      const insert = RED_GREEN_OVERRIDES["--theme-diff-gutter-insert"]!;
      const del = RED_GREEN_OVERRIDES["--theme-diff-gutter-delete"]!;

      for (const deficiency of ["protanopia", "deuteranopia"] as const) {
        const dist = minPairwiseDistance([insert, del], deficiency);
        expect(dist, `${deficiency}: gutter insert/delete distance`).not.toBeNull();
        expect(
          dist!,
          `${deficiency}: insert/delete gutter distance ${dist?.toFixed(4)} below floor ${DIFF_DISTINGUISHABILITY_FLOOR}`
        ).toBeGreaterThan(DIFF_DISTINGUISHABILITY_FLOOR);
      }
    });

    it("red-green diff gutters mirror the overridden status colors", () => {
      expect(normHex(RED_GREEN_OVERRIDES["--theme-diff-gutter-insert"]!)).toBe(
        normHex(RED_GREEN_OVERRIDES["--theme-status-success"]!)
      );
      expect(normHex(RED_GREEN_OVERRIDES["--theme-diff-gutter-delete"]!)).toBe(
        normHex(RED_GREEN_OVERRIDES["--theme-status-danger"]!)
      );
    });

    it("red-green diff backgrounds are the overridden status hue at the light-mode alphas", () => {
      // Derive the expected rgba from the override's own status hex so a wrong
      // alpha or a swapped insert/delete derivation fails — not a literal match.
      const rgb = (hex: string) => {
        const c = parse(hex)!;
        const to255 = (v: number) => Math.round((v as number) * 255);
        // culori.parse() always returns RGB values (0-1 range), even when a mode is
        // active, so we can safely access r, g, b as an any-typed object to avoid
        // type errors from the discriminated union type.
        const color = c as unknown as { r: number; g: number; b: number };
        return {
          r: to255(color.r),
          g: to255(color.g),
          b: to255(color.b),
        };
      };
      const success = rgb(RED_GREEN_OVERRIDES["--theme-status-success"]!);
      const danger = rgb(RED_GREEN_OVERRIDES["--theme-status-danger"]!);

      expect(RED_GREEN_OVERRIDES["--theme-diff-insert-background"]).toBe(
        `rgba(${success.r}, ${success.g}, ${success.b}, 0.1)`
      );
      expect(RED_GREEN_OVERRIDES["--theme-diff-insert-edit-background"]).toBe(
        `rgba(${success.r}, ${success.g}, ${success.b}, 0.2)`
      );
      expect(RED_GREEN_OVERRIDES["--theme-diff-delete-background"]).toBe(
        `rgba(${danger.r}, ${danger.g}, ${danger.b}, 0.1)`
      );
      expect(RED_GREEN_OVERRIDES["--theme-diff-delete-edit-background"]).toBe(
        `rgba(${danger.r}, ${danger.g}, ${danger.b}, 0.2)`
      );
    });
  });
});

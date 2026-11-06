import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatHex, interpolate, parse } from "culori";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { blendOverBackground, contrastRatio, parseRgba } from "../contrast.js";
import { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES } from "../colorVisionOverrides.js";
import { WORKTREE_LABEL_COLORS } from "../worktreeColors.js";

// #13408 — a colour label is the only thing marking a worktree, so its bar owes
// WCAG 1.4.11's 3:1 against every plane the card can sit on, on every built-in
// theme and colour-vision mode. The ink is derived in sidebar.css; this reads
// the derivation from there so the two cannot drift.

const sidebarCss = readFileSync(
  resolve(__dirname, "../../../src/styles/components/sidebar.css"),
  "utf-8"
);

function labelMixPercent(): number {
  const match = sidebarCss.match(
    /\.worktree-label-bar,\s*\.worktree-label-swatch\s*\{\s*background-color:\s*color-mix\(\s*in oklab,\s*var\(--worktree-label-color\)\s*(\d+)%,\s*var\(--theme-text-primary\)\s*\)/
  );
  if (!match) throw new Error("label ink rule not found in sidebar.css");
  return Number(match[1]);
}

/** The card plane's CSS fallbacks in sidebar.css, used when a theme sets no extension. */
const PLANE_FALLBACKS = {
  resting: ["sidebar-card-bg", "rgba(255, 255, 255, 0.03)"],
  hovered: ["sidebar-hover-bg", "rgba(255, 255, 255, 0.064)"],
  selected: ["sidebar-active-bg", "rgba(255, 255, 255, 0.096)"],
} as const;

function composite(value: string, base: string): string {
  if (value.startsWith("#")) return value.slice(0, 7);
  const rgba = parseRgba(value);
  if (!rgba) throw new Error(`unparseable plane colour: ${value}`);
  return blendOverBackground(rgba.hex, base, rgba.opacity);
}

function mixInOklab(color: string, other: string, colorPercent: number): string {
  const a = parse(color);
  const b = parse(other);
  if (!a || !b) throw new Error(`unparseable colour: ${color} / ${other}`);
  return formatHex(interpolate([a, b], "oklab")(1 - colorPercent / 100));
}

const MODES = [
  ["default", {}],
  ["red-green", RED_GREEN_OVERRIDES],
  ["blue-yellow", BLUE_YELLOW_OVERRIDES],
] as const;

describe("worktree label contrast (#13408)", () => {
  it("holds every label at 3:1 against the resting, hovered and selected card", () => {
    const percent = labelMixPercent();
    const failures: string[] = [];

    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const base = scheme.tokens["surface-sidebar"];
      const extensions = (scheme.extensions ?? {}) as Record<string, string | undefined>;
      const textPrimary = scheme.tokens["text-primary"];

      for (const [plane, [key, fallback]] of Object.entries(PLANE_FALLBACKS)) {
        const surface = composite(extensions[key] ?? fallback, base);

        for (const [mode, overrides] of MODES) {
          for (const label of WORKTREE_LABEL_COLORS) {
            const raw =
              (overrides as Record<string, string>)[`--theme-${label.token}`] ??
              scheme.tokens[label.token];
            const ink = mixInOklab(raw, textPrimary, percent);
            const ratio = contrastRatio(ink, surface);
            if (ratio < 3) {
              failures.push(
                `${scheme.id} ${mode} ${plane}: ${label.label} ${ink} on ${surface} = ${ratio.toFixed(2)}`
              );
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

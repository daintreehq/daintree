/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  APP_THEME_TOKEN_KEYS,
  BUILT_IN_APP_SCHEMES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
  type AppColorScheme,
  type AppThemeTokenKey,
} from "@shared/theme";
import { ROW_TONE_CLASS, type ProjectRowStatus, type ProjectRowTone } from "../projectRowStatus";
import { RowStatusLine } from "@/components/Project/ProjectSwitcherRows";

// The switcher's status sentences are small text, so every tone owes AA on the
// row it paints on: the palette surface at rest, and the highlight fill over it
// when the row is the cursor. A tone drifting back to a graphical ink fails here
// on the themes where that ink is only 3:1 grade.

const TOKEN_KEYS: ReadonlySet<string> = new Set(APP_THEME_TOKEN_KEYS);

function isTokenKey(name: string): name is AppThemeTokenKey {
  return TOKEN_KEYS.has(name);
}

function isTone(name: string): name is ProjectRowTone {
  return name in ROW_TONE_CLASS;
}

const TONES = Object.keys(ROW_TONE_CLASS).filter(isTone);

function inkOf(classes: string): AppThemeTokenKey {
  const inks = classes
    .split(/\s+/)
    .map((c) => /^text-([a-z-]+)$/.exec(c)?.[1])
    .filter((name): name is AppThemeTokenKey => name !== undefined && isTokenKey(name));
  expect(inks, classes).toHaveLength(1);
  return inks[0]!;
}

function opaque(value: string): { hex: string; opacity: number } {
  const rgba = parseRgba(value);
  if (rgba) return rgba;
  if (/^#[0-9a-f]{8}$/i.test(value)) {
    return { hex: value.slice(0, 7), opacity: parseInt(value.slice(7), 16) / 255 };
  }
  return { hex: value, opacity: 1 };
}

function rowBackdrops(scheme: AppColorScheme): Array<{ label: string; hex: string }> {
  const t = scheme.tokens;
  const surfaces =
    scheme.type === "light"
      ? [{ label: "surface-panel-elevated", hex: t["surface-panel-elevated"] }]
      : [
          { label: "surface-sidebar", hex: t["surface-sidebar"] },
          ...(
            ["surface-grid", "surface-canvas", "surface-panel", "surface-panel-elevated"] as const
          ).map((key) => ({
            label: `palette over ${key}`,
            hex: blendOverBackground(t["surface-sidebar"], t[key], 0.94),
          })),
        ];
  const highlight = opaque(t["overlay-highlight"]);
  return surfaces.flatMap((surface) => [
    { label: `${surface.label} (resting)`, hex: surface.hex },
    {
      label: `${surface.label} (highlighted)`,
      hex: blendOverBackground(highlight.hex, surface.hex, highlight.opacity),
    },
  ]);
}

function expectLegible(where: string, ink: AppThemeTokenKey): void {
  for (const scheme of BUILT_IN_APP_SCHEMES) {
    for (const backdrop of rowBackdrops(scheme)) {
      const ratio = contrastRatio(scheme.tokens[ink], backdrop.hex);
      expect(
        ratio,
        `${where} (${ink}) on ${scheme.id} ${backdrop.label}: ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

afterEach(() => cleanup());

describe("project row status line contrast (#15866)", () => {
  it.each(Object.entries(ROW_TONE_CLASS))(
    "the %s tone reads at AA on every built-in row",
    (tone, classes) => {
      expectLegible(tone, inkOf(classes));
    }
  );

  // What the line actually paints, so a span that stops reading the map can't
  // keep this suite measuring an ink nothing draws.
  it.each(TONES)("a %s line paints every fragment at AA on every built-in row", (tone) => {
    const status: ProjectRowStatus = {
      text: "2 agents unread",
      tone,
      markTone: null,
      agentMix: { demand: 2, running: 3 },
      livenessDetail: "3 running",
      ageDetail: "oldest 10m",
    };
    const { container } = render(<RowStatusLine status={status} />);
    // The fragments themselves, not the separators between them: a visual dot
    // hidden from assistive tech, and a comma only assistive tech reads.
    const spans = Array.from(container.querySelectorAll("span")).filter(
      (span) => span.getAttribute("aria-hidden") !== "true" && !span.classList.contains("sr-only")
    );
    expect(spans.map((span) => span.textContent)).toEqual([
      "3 running",
      "2 agents unread",
      "oldest 10m",
    ]);
    for (const span of spans) {
      expectLegible(`"${span.textContent}"`, inkOf(span.getAttribute("class") ?? ""));
    }
  });
});

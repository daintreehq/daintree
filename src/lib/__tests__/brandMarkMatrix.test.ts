import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { converter, modeOklch, modeRgb, useMode as registerMode } from "culori/fn";
import {
  BUILT_IN_APP_SCHEMES,
  DISPLAY_SURFACES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { resolveBrandMarkInk } from "../brandIcon";

registerMode(modeRgb);
registerMode(modeOklch);
const toOklch = converter("oklch");

const FLOOR = 3;

/**
 * The whole-roster guarantee. Everything here iterates the registries rather
 * than a copied list, so a new agent or a new theme is covered the moment it is
 * added and the suite fails if either one breaks the floor. That guard is what
 * makes adding a CLI safe rather than something to check by hand.
 */
const AGENTS = Object.entries(AGENT_REGISTRY)
  .map(([id, config]) => [id, config.color] as const)
  .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string");

/** Channel-wise sRGB interpolation, matching how a `color` transition crossfades. */
function mix(from: string, to: string, ratio: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(from.slice(offset, offset + 2), 16);
    const b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * ratio)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/**
 * Composes each display surface with the hover overlay independently of the
 * resolver, so the suite measures against backdrops it derived itself rather
 * than trusting the implementation's own idea of where a mark lands.
 */
function surfacePairs(scheme: AppColorScheme): Array<{ base: string; hovered: string }> {
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  return DISPLAY_SURFACES.map((key) => scheme.tokens[key]!)
    .filter((base) => /^#[0-9a-f]{6}$/i.test(base))
    .map((base) => ({
      base,
      hovered: overlay ? blendOverBackground(overlay.hex, base, overlay.opacity) : base,
    }));
}

describe("brand marks across the whole registry", () => {
  it("actually covers the whole roster, every theme and every surface", () => {
    // Every loop below filters, and a filter that quietly empties turns the
    // whole matrix into a no-op that still reports green. These are the
    // preconditions that make the coverage claims mean something.
    expect(AGENTS).toHaveLength(Object.keys(AGENT_REGISTRY).length);
    expect(BUILT_IN_APP_SCHEMES.length).toBeGreaterThan(1);
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(surfacePairs(scheme)).toHaveLength(DISPLAY_SURFACES.length);
      expect(toOklch(scheme.tokens["text-secondary"])?.l).toBeDefined();
    }
  });

  it("resolves an ink for every agent on every built-in theme", () => {
    const unresolved = AGENTS.flatMap(([id, color]) =>
      BUILT_IN_APP_SCHEMES.filter((scheme) => resolveBrandMarkInk(color, scheme) === null).map(
        (scheme) => `${id} on ${scheme.id}`
      )
    );
    expect(unresolved).toEqual([]);
  });

  it("clears the non-text contrast floor at rest, on hover, and mid-transition", () => {
    const failures: string[] = [];

    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        const ink = resolveBrandMarkInk(color, scheme);
        if (!ink) continue;

        for (const { base, hovered } of surfacePairs(scheme)) {
          const samples: Array<[string, string, string]> = [
            ["rest/resting", ink.rest, base],
            ["rest/hovered", ink.rest, hovered],
            ["hover/resting", ink.hover, base],
            ["hover/hovered", ink.hover, hovered],
            // The correlated midpoint: foreground and backdrop are both halfway
            // through the same 150ms crossfade. Endpoints passing does not imply
            // the frames between them pass.
            ["midpoint", mix(ink.rest, ink.hover, 0.5), mix(base, hovered, 0.5)],
          ];
          for (const [label, fg, bg] of samples) {
            const ratio = contrastRatio(fg, bg);
            if (ratio < FLOOR) {
              failures.push(`${id} on ${scheme.id} ${base} ${label}: ${ratio.toFixed(2)}:1`);
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("gives every hued brand the same resting chroma and its own hue", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const inkLightness = toOklch(scheme.tokens["text-secondary"])?.l;
      if (inkLightness === undefined) continue;

      const chromas: number[] = [];
      for (const [, color] of AGENTS) {
        const brand = toOklch(color);
        const resolved = resolveBrandMarkInk(color, scheme);
        if (!brand || !resolved) continue;

        const rest = toOklch(resolved.rest)!;
        // Rest never departs from the theme's own icon-ink lightness — that is
        // what carries the contrast guarantee, with no surface provenance
        // threaded anywhere.
        expect(rest.l).toBeCloseTo(inkLightness, 2);

        // Achromatic brands are identified by conversion, not by an id list, so
        // a new one degrades on its own rather than needing an exception entry.
        if (brand.h === undefined || (brand.c ?? 0) <= 1e-4) {
          expect(resolved.rest.toLowerCase()).toBe(scheme.tokens["text-secondary"]!.toLowerCase());
        } else {
          chromas.push(rest.c ?? 0);
        }
      }

      // Eighteen marks read as *equally* tinted only if the spread is tight;
      // a chroma scaled off each brand's own would blow this apart.
      if (chromas.length > 1) {
        expect(Math.max(...chromas) - Math.min(...chromas)).toBeLessThan(0.01);
      }
    }
  });

  it("leaves a brand colour untouched wherever it is already legible", () => {
    let exercised = 0;
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        const ink = resolveBrandMarkInk(color, scheme);
        if (!ink) continue;

        const pairs = surfacePairs(scheme);
        const alreadySafe = pairs.every(
          ({ base, hovered }) =>
            contrastRatio(color, base) >= FLOOR &&
            contrastRatio(color, hovered) >= FLOOR &&
            contrastRatio(mix(ink.rest, color, 0.5), mix(base, hovered, 0.5)) >= FLOOR
        );
        if (alreadySafe) {
          exercised++;
          expect(`${id}/${scheme.id}:${ink.hover.toLowerCase()}`).toBe(
            `${id}/${scheme.id}:${color.toLowerCase()}`
          );
        }
      }
    }
    // Correction is meant to be the exception, not the rule. If nothing reached
    // the assertion the test proved nothing.
    expect(exercised).toBeGreaterThan(0);
  });

  it("transitions colour alone, never a widened property list", () => {
    // CLAUDE.md forbids widening to `transition`/`transition-all`; this reads the
    // shipped rule rather than the constant, so retuning the duration token does
    // not drag the test with it.
    const css = readFileSync(fileURLToPath(new URL("../../index.css", import.meta.url)), "utf8");
    const rule = /\.brand-mark\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();

    const transition = /transition:\s*([^;]+);/.exec(rule![1]!);
    expect(transition).not.toBeNull();
    const properties = transition![1]!.split(",").map((part) => part.trim().split(/\s+/)[0]);
    expect(properties).toEqual(["color"]);
  });

  it("derives everything from the brand hex and the theme, with no agent table", () => {
    // The structural half of "adding a CLI costs one hex": a resolver that knew
    // about agents could pass every contrast assertion above and still need an
    // entry per agent.
    const source = readFileSync(fileURLToPath(new URL("../brandIcon.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/from\s+["'].*agent/i);

    const leaked = AGENTS.filter(
      ([id, color]) =>
        source.toLowerCase().includes(color.toLowerCase()) ||
        new RegExp(`["'\`]${id}["'\`]`, "i").test(source)
    ).map(([id]) => id);
    expect(leaked).toEqual([]);
  });
});

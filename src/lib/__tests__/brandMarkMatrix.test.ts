import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { converter, modeOklab, modeRgb, useMode as registerMode } from "culori/fn";
import {
  BUILT_IN_APP_SCHEMES,
  apcaLc,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "@shared/theme";
import type { AppColorScheme, AppThemeTokenKey } from "@shared/theme";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { BRAND_MARK_SURFACES, resolveBrandMarkInk } from "../brandIcon";

registerMode(modeRgb);
registerMode(modeOklab);
const toOklab = converter("oklab");

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
function backdropsFor(
  scheme: AppColorScheme,
  surface: AppThemeTokenKey
): { rest: string; active: string } {
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  const rest = scheme.tokens[surface]!;
  return {
    rest,
    active: overlay ? blendOverBackground(overlay.hex, rest, overlay.opacity) : rest,
  };
}

function opaqueSurfaces(scheme: AppColorScheme): AppThemeTokenKey[] {
  return BRAND_MARK_SURFACES.filter((key) => /^#[0-9a-f]{6}$/i.test(scheme.tokens[key] ?? ""));
}

/** Worst contrast anywhere in the correlated crossfade, sampled far finer than the resolver does. */
function worstAcrossFade(
  rest: string,
  active: string,
  pair: { rest: string; active: string }
): number {
  let worst = Infinity;
  for (let step = 0; step <= 40; step++) {
    const t = step / 40;
    worst = Math.min(worst, contrastRatio(mix(rest, active, t), mix(pair.rest, pair.active, t)));
  }
  return worst;
}

/** OKLab distance — the space the fade is sized in. */
function deltaE(a: string, b: string): number {
  const one = toOklab(a)!;
  const two = toOklab(b)!;
  return Math.hypot(one.l - two.l, one.a - two.a, one.b - two.b);
}

describe("brand marks across the whole registry", () => {
  it("actually covers the whole roster, every theme and every surface", () => {
    // Every loop below filters, and a filter that quietly empties turns the
    // whole matrix into a no-op that still reports green. These are the
    // preconditions that make the coverage claims mean something.
    expect(AGENTS).toHaveLength(Object.keys(AGENT_REGISTRY).length);
    expect(BUILT_IN_APP_SCHEMES.length).toBeGreaterThan(1);
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(opaqueSurfaces(scheme)).toHaveLength(BRAND_MARK_SURFACES.length);
    }
  });

  it("resolves an ink for every agent on every theme, surface and un-named placement", () => {
    const unresolved: string[] = [];
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of [...BRAND_MARK_SURFACES, null]) {
          const ink = resolveBrandMarkInk(color, scheme, surface ? { surface } : null);
          if (!ink) unresolved.push(`${id} on ${scheme.id} / ${surface ?? "unnamed"}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("clears the non-text contrast floor at rest, when active, and mid-transition", () => {
    const failures: string[] = [];

    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of opaqueSurfaces(scheme)) {
          const pair = backdropsFor(scheme, surface);
          const ink = resolveBrandMarkInk(color, scheme, { surface })!;

          // A selected tab is not a hovered one, so the active ink is painted on
          // the resting backdrop as well as the lifted one.
          for (const [label, hex, bg] of [
            ["active/resting", ink.active, pair.rest],
            ["active/hovered", ink.active, pair.active],
          ] as const) {
            const ratio = contrastRatio(hex, bg);
            if (ratio < FLOOR) failures.push(`${id}/${scheme.id}/${surface} ${label}: ${ratio}`);
          }

          // The correlated crossfade: foreground and backdrop are both moving,
          // and the minimum can sit between the endpoints rather than at one.
          const worst = worstAcrossFade(ink.rest, ink.active, pair);
          if (worst < FLOOR) {
            failures.push(`${id}/${scheme.id}/${surface} crossfade: ${worst.toFixed(3)}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("stays safe on every surface when the placement is not declared", () => {
    // An un-wrapped call site is a real state, so the fallback has to clear the
    // floor on every surface rather than on the one it happened to pick.
    const failures: string[] = [];
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        const ink = resolveBrandMarkInk(color, scheme)!;
        for (const surface of opaqueSurfaces(scheme)) {
          const worst = worstAcrossFade(ink.rest, ink.active, backdropsFor(scheme, surface));
          if (worst < FLOOR) {
            failures.push(`${id}/${scheme.id}/${surface}: ${worst.toFixed(3)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("gives every mark a reveal to hover into", () => {
    // The failure this pins is silent: a mark that never reacts to being hovered
    // or selected is perfectly legible and completely dead. Every pair gets a
    // step, none of them gets so much that the resting state reads as a
    // different colour — except where the resting weight ceiling is what set the
    // distance, which is a normalisation of an over-loud brand rather than a
    // fade, and is allowed to be longer.
    const failures: string[] = [];
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of opaqueSurfaces(scheme)) {
          const ink = resolveBrandMarkInk(color, scheme, { surface })!;
          const fade = deltaE(ink.rest, ink.active);
          const bg = scheme.tokens[surface]!;
          const ceiling = apcaLc(scheme.tokens["text-secondary"]!, bg) + 11;
          const atCeiling = Math.abs(apcaLc(ink.rest, bg) - ceiling) < 1.5;
          const ceilingFor = atCeiling ? 0.16 : 0.09;
          if (fade < 0.04 || fade > ceilingFor) {
            failures.push(`${id}/${scheme.id}/${surface}: ${fade.toFixed(3)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("carries the documented weight when active", () => {
    // docs/themes/interaction-state-recipes.md says an active mark carries APCA
    // Lc 35 against the weaker of its two backdrops. Nothing else in the suite
    // measures that: the APCA module's own tests prove the calculator, not that
    // the resolver applies it.
    const failures: string[] = [];
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of opaqueSurfaces(scheme)) {
          const pair = backdropsFor(scheme, surface);
          const ink = resolveBrandMarkInk(color, scheme, { surface })!;
          const carried = Math.min(apcaLc(ink.active, pair.rest), apcaLc(ink.active, pair.active));
          if (carried < 35) {
            failures.push(`${id}/${scheme.id}/${surface}: Lc ${carried.toFixed(0)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("never rests louder than the row it sits in", () => {
    // The neutral controls beside a mark are painted in `text-secondary`. A
    // resting mark that lands well above them reads as a primary control, which
    // is the failure the ceiling exists to stop.
    const failures: string[] = [];
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of opaqueSurfaces(scheme)) {
          const bg = scheme.tokens[surface]!;
          const ink = resolveBrandMarkInk(color, scheme, { surface })!;
          const over = apcaLc(ink.rest, bg) - apcaLc(scheme.tokens["text-secondary"]!, bg);
          if (over > 12) failures.push(`${id}/${scheme.id}/${surface}: +${over.toFixed(0)} Lc`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("holds the brand's own hue in both states", () => {
    // Correcting by clipping sRGB channels would shift the hue, which is the one
    // property a mark cannot give up and still be the brand's.
    const failures: string[] = [];
    for (const [id, color] of AGENTS) {
      const brand = toOklab(color)!;
      const brandHue = (Math.atan2(brand.b, brand.a) * 180) / Math.PI;
      const brandChroma = Math.hypot(brand.a, brand.b);
      if (brandChroma < 0.02) continue; // No hue to hold.

      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of BRAND_MARK_SURFACES) {
          const ink = resolveBrandMarkInk(color, scheme, { surface })!;
          for (const [label, hex] of [
            ["rest", ink.rest],
            ["active", ink.active],
          ] as const) {
            const lab = toOklab(hex)!;
            if (Math.hypot(lab.a, lab.b) < 0.01) continue; // Faded past the point of having one.
            const hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
            const gap = Math.abs(((hue - brandHue + 540) % 360) - 180);
            if (gap > 3) failures.push(`${id}/${scheme.id}/${surface} ${label}: ${gap.toFixed(1)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("shows a brand colour untouched wherever it can carry both states", () => {
    let exercised = 0;
    for (const [id, color] of AGENTS) {
      for (const scheme of BUILT_IN_APP_SCHEMES) {
        for (const surface of opaqueSurfaces(scheme)) {
          const ink = resolveBrandMarkInk(color, scheme, { surface })!;
          if (ink.active.toLowerCase() !== color.toLowerCase()) continue;
          exercised++;
          // Untouched is only allowed where it is also correct: the mark clears
          // the floor on both backdrops and still has room for its fade.
          const pair = backdropsFor(scheme, surface);
          expect(
            `${id}/${scheme.id}/${surface}:${worstAcrossFade(ink.rest, ink.active, pair) >= FLOOR}`
          ).toBe(`${id}/${scheme.id}/${surface}:true`);
        }
      }
    }
    // Correction is meant to be the exception on the themes with headroom. If
    // nothing reached the assertion the test proved nothing.
    expect(exercised).toBeGreaterThan(AGENTS.length);
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

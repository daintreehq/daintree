import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildAssistantPalette } from "../palette";
import { contrast, luminance } from "@/utils/colorContrast";
import { BUILT_IN_SCHEMES } from "@/config/terminalColorSchemes";
import type { ITheme } from "@xterm/xterm";
import { resolveInputBarColors } from "@/utils/terminalTheme";

/**
 * The panel's palette must be legible on EVERY terminal theme Daintree ships.
 *
 * This is the test the panel needed and did not have. Two versions of the palette
 * shipped looking correct on the themes anyone happened to open:
 *
 *   1. Ground from the terminal theme, ink from the APP's tokens. Independent choices,
 *      so a light app theme with a dark terminal put dark ink on a dark ground — the
 *      answer measured 1.03:1 against its own background.
 *   2. Ink as a fixed percentage of the terminal foreground. Reads well on a theme with
 *      headroom; fails on one without, because a percentage cannot know what it is
 *      standing on. Solarized Light's own foreground is 4.13:1 BEFORE anything is
 *      derived from it, and ANSI yellow on Ayu Light is 1.84:1.
 *
 * Neither failed a test, because no test looked at more than one theme. This one walks
 * all of them and does the arithmetic.
 */

const parse = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/** WCAG floors. */
const TEXT = 4.5;
const GRAPHIC = 3;

/**
 * The palette for one scheme.
 *
 * `resolveInputBarColors` reads `document.documentElement.dataset.colorMode`, which is
 * why this runs under the jsdom environment the suite already uses.
 */
function paletteFor(scheme: (typeof BUILT_IN_SCHEMES)[number]) {
  return buildAssistantPalette(resolveInputBarColors(scheme.colors));
}

/** Every ink that must be READ, and the ground it is read against. */
const TEXT_TIERS = [
  "--assistant-fg",
  "--assistant-fg-secondary",
  "--assistant-danger",
  "--assistant-warning",
  "--assistant-success",
  "--assistant-accent",
] as const;

/** Icons, focus rings, state dots — recognisable rather than readable. */
const GRAPHIC_TIERS = [
  "--assistant-fg-dim",
  "--assistant-danger-graphic",
  "--assistant-warning-graphic",
  "--assistant-success-graphic",
  "--assistant-focus",
  "--assistant-mark",
] as const;

/**
 * The grounds an ink can land on. `inset` is the worst — it is mixed toward the
 * foreground, so it is the surface every foreground-derived ink sits least well on.
 */
const GROUNDS = ["--assistant-surface", "--assistant-raised", "--assistant-inset"] as const;

describe("assistant palette contrast floors", () => {
  it("ships enough terminal schemes for this to mean anything", () => {
    // Guards the whole file: an empty or tiny list would make every case below vacuous.
    expect(BUILT_IN_SCHEMES.length).toBeGreaterThanOrEqual(10);
    expect(BUILT_IN_SCHEMES.some((s) => s.type === "light")).toBe(true);
    expect(BUILT_IN_SCHEMES.some((s) => s.type === "dark")).toBe(true);
  });

  for (const scheme of BUILT_IN_SCHEMES) {
    describe(scheme.name, () => {
      it("clears the 4.5:1 body floor for every readable tier, on every ground", () => {
        const palette = paletteFor(scheme);
        const failures: string[] = [];
        for (const tier of TEXT_TIERS) {
          for (const ground of GROUNDS) {
            const ratio = contrast(parse(palette[tier]!), parse(palette[ground]!));
            if (ratio + 1e-9 < TEXT) {
              failures.push(`${tier} on ${ground} = ${ratio.toFixed(2)}:1`);
            }
          }
        }
        expect(failures, `${scheme.name}:\n  ${failures.join("\n  ")}`).toEqual([]);
      });

      it("clears the 3:1 non-text floor for every graphical tier", () => {
        const palette = paletteFor(scheme);
        const failures: string[] = [];
        for (const tier of GRAPHIC_TIERS) {
          for (const ground of GROUNDS) {
            const ratio = contrast(parse(palette[tier]!), parse(palette[ground]!));
            if (ratio + 1e-9 < GRAPHIC) {
              failures.push(`${tier} on ${ground} = ${ratio.toFixed(2)}:1`);
            }
          }
        }
        expect(failures, `${scheme.name}:\n  ${failures.join("\n  ")}`).toEqual([]);
      });

      it("keeps the warning tint a GROUND, legible under the panel's own text", () => {
        // An approval card's tint sits under body text. A tint that reads as a colour
        // in its own right takes the text on top of it below the floor.
        const palette = paletteFor(scheme);
        const ratio = contrast(
          parse(palette["--assistant-fg"]!),
          parse(palette["--assistant-warning-surface"]!)
        );
        expect(
          ratio,
          `body text on the warning tint = ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(TEXT);
      });

      it("survives INVERSE VIDEO — the approval card's weighted Decline button", () => {
        // `bg-[--assistant-fg]` with `text-[--assistant-surface]`, matching the
        // cockpit's inverse-video default. The pair has to clear the floor in its own
        // right; on Solarized Light the terminal's raw pair is only 4.13:1.
        const palette = paletteFor(scheme);
        const ratio = contrast(
          parse(palette["--assistant-surface"]!),
          parse(palette["--assistant-fg"]!)
        );
        expect(ratio, `inverse video = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT);
      });

      it("keeps the surfaces distinguishable from the ground without becoming grounds", () => {
        // A raised surface nobody can see is not a surface; one that reads as a second
        // background makes the panel look like two panes stitched together.
        const palette = paletteFor(scheme);
        for (const surface of ["--assistant-raised", "--assistant-inset"] as const) {
          const delta = Math.abs(
            luminance(parse(palette[surface]!)) - luminance(parse(palette["--assistant-surface"]!))
          );
          expect(delta, `${surface} is indistinguishable from the ground`).toBeGreaterThan(0.0015);
          expect(delta, `${surface} reads as a second ground`).toBeLessThan(0.2);
        }
      });
    });
  }
});

/**
 * Themes nobody ships, chosen to break the derivation.
 *
 * The shipped set is what users see, but it is not the whole input space: Daintree
 * imports VS Code colour schemes, and a custom theme can name anything. Each of these
 * is a shape that broke an earlier version of this file, kept so it cannot come back.
 */
const ADVERSARIAL: { name: string; colors: ITheme }[] = [
  {
    // Mid-grey ground with a white foreground. The raw pair PASSES at ~5.1:1, so
    // nothing looks wrong — but the inset surface is lighter still, and correcting
    // against inset alone flipped primary to near-black, which then failed against the
    // panel's own ground at 3.6:1. Solved for one surface, broken on another.
    name: "mid-grey ground, light foreground",
    colors: { background: "#6e6e6e", foreground: "#ffffff", cursor: "#00ff00", red: "#ff0000" },
  },
  {
    // The mirror: a mid-grey ground with dark ink.
    name: "mid-grey ground, dark foreground",
    colors: { background: "#8a8a8a", foreground: "#111111", cursor: "#0000ff", red: "#880000" },
  },
  {
    // Foreground and background identical — a half-written custom theme. Text must
    // still be corrected to something legible, and the surfaces must not collapse into
    // the ground and take every card and rule with them.
    name: "foreground equals background",
    colors: { background: "#202020", foreground: "#202020", cursor: "#202020", red: "#202020" },
  },
  {
    name: "pure black on pure white",
    colors: { background: "#ffffff", foreground: "#000000", cursor: "#ffff00", red: "#ff0000" },
  },
  {
    name: "pure white on pure black",
    colors: { background: "#000000", foreground: "#ffffff", cursor: "#0000ff", red: "#330000" },
  },
  {
    // Every colour unparseable. The fallbacks have to carry the whole palette.
    name: "colours this parser does not understand",
    colors: {
      background: "hsl(210 40% 12%)",
      foreground: "rebeccapurple",
      cursor: "not a colour",
      red: "",
    },
  },
];

describe("adversarial themes", () => {
  for (const theme of ADVERSARIAL) {
    it(`stays legible: ${theme.name}`, () => {
      const palette = buildAssistantPalette(resolveInputBarColors(theme.colors));
      const failures: string[] = [];
      for (const tier of TEXT_TIERS) {
        for (const ground of GROUNDS) {
          const ratio = contrast(parse(palette[tier]!), parse(palette[ground]!));
          if (ratio + 1e-9 < TEXT) failures.push(`${tier} on ${ground} = ${ratio.toFixed(2)}:1`);
        }
      }
      for (const tier of GRAPHIC_TIERS) {
        for (const ground of GROUNDS) {
          const ratio = contrast(parse(palette[tier]!), parse(palette[ground]!));
          if (ratio + 1e-9 < GRAPHIC) failures.push(`${tier} on ${ground} = ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures, `${theme.name}:\n  ${failures.join("\n  ")}`).toEqual([]);
    });

    it(`separates its surfaces VISIBLY: ${theme.name}`, () => {
      // A panel whose raised and inset surfaces equal its ground has no cards, no rules
      // and no inset edges. Structure must degrade last, not first — and "different
      // string" is not the test, because one 8-bit step apart is invisible.
      const palette = buildAssistantPalette(resolveInputBarColors(theme.colors));
      const ground = luminance(parse(palette["--assistant-surface"]!));
      for (const surface of ["--assistant-raised", "--assistant-inset"] as const) {
        const delta = Math.abs(luminance(parse(palette[surface]!)) - ground);
        expect(delta, `${surface} is not visibly separated from the ground`).toBeGreaterThan(
          0.0015
        );
      }
    });

    it(`emits only well-formed colours: ${theme.name}`, () => {
      const palette = buildAssistantPalette(resolveInputBarColors(theme.colors));
      for (const [name, value] of Object.entries(palette)) {
        expect(value, `${name} is not a hex colour`).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  }
});

/**
 * The floors are only worth having if the panel actually uses the tiers.
 *
 * A component that reaches past them — an app token, a raw hex, an `opacity` on text —
 * is outside everything asserted above, and that is exactly how both previous versions
 * of this palette shipped.
 */
describe("the panel takes its colour only from the palette", () => {
  const DIR = path.resolve(__dirname, "..");
  const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".css"));

  it("names no app colour token", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(DIR, file), "utf8");
      for (const [i, line] of source.split("\n").entries()) {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        const hit =
          /\bvar\(--(?:color|theme)-/.exec(line) ??
          /(?<![\w-])(?:text|bg|border|ring|outline|decoration|fill)-(?:text|surface|border|status|overlay|accent)-[a-z]/.exec(
            line
          );
        if (hit) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    }
    expect(offenders, `app colour tokens in the panel:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("inherits the CORRECTED foreground, not the terminal's raw one", () => {
    // The panel root's `color` is what every unstyled element inherits, so a raw
    // `term.foreground` there quietly exempts all of them from the correction this
    // whole file exists to enforce — each named tier fixed, and any text that simply
    // did not name a colour inheriting the uncorrected value anyway.
    const view = readFileSync(path.resolve(DIR, "AssistantPanelView.tsx"), "utf8");
    const style = /backgroundColor:\s*([^,\n]+),\s*\n[\s\S]{0,900}?\n\s*color:\s*([^,\n]+),/.exec(
      view
    );
    expect(style, "the panel root's colour declarations could not be read").not.toBeNull();
    expect(style![1], "the panel ground is not taken from the palette").toContain("paletteVars");
    expect(style![2], "the panel's inherited ink is not taken from the palette").toContain(
      "paletteVars"
    );
  });

  it("does not dim readable text with opacity", () => {
    // `opacity` scales an element toward whatever is behind it, taking its contrast
    // floor with it — so a tier corrected to 4.5:1 lands at 3.1:1 under `opacity-70`
    // and nothing above notices. Only `disabled:` is allowed: text that cannot be
    // acted on is meant to recede, and it is not information.
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(DIR, file), "utf8");
      for (const [i, line] of source.split("\n").entries()) {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        for (const m of line.matchAll(/(?<![\w-])([a-z-]*:)?opacity-(\d+)/g)) {
          if (m[1]?.startsWith("disabled")) continue;
          offenders.push(`${file}:${i + 1}  ${m[0]}`);
        }
      }
    }
    expect(offenders, `opacity on panel text:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

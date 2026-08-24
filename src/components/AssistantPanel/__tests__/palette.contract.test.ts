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
  // The raw ANSI slots go in ALONGSIDE the narrowed colours: fenced-code syntax is
  // coloured from the 16-colour half that `resolveInputBarColors` throws away, and
  // omitting it here would exercise only the fallbacks — asserting floors on colours
  // no user ever sees.
  return buildAssistantPalette(resolveInputBarColors(scheme.colors), scheme.colors);
}

/** Every ink that must be READ, and the ground it is read against. */
const TEXT_TIERS = [
  "--assistant-fg",
  "--assistant-fg-secondary",
  "--assistant-danger",
  "--assistant-warning",
  "--assistant-success",
  "--assistant-accent",
  // Inline code, and the five roles a fenced block is painted with. All READ, all
  // therefore on the text floor — including comments, which is the tempting exception
  // and the wrong one: a comment is prose, and often the line in a snippet that most
  // needs reading.
  "--assistant-code",
  "--assistant-syntax-comment",
  "--assistant-syntax-keyword",
  "--assistant-syntax-string",
  "--assistant-syntax-number",
  "--assistant-syntax-function",
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
      const palette = buildAssistantPalette(resolveInputBarColors(theme.colors), theme.colors);
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
      const palette = buildAssistantPalette(resolveInputBarColors(theme.colors), theme.colors);
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

/**
 * The floors prove every ink is LEGIBLE. They cannot prove any ink came from the theme.
 *
 * A palette that ignored the ANSI slots entirely — mapping all five syntax roles to one
 * readable grey — would pass every assertion above, on every scheme. So would one that
 * swapped keyword and string. These test the WIRING: change one slot in the terminal
 * theme, and exactly the token that reads it must move.
 *
 * Written differentially rather than by asserting hex values, which would just copy the
 * implementation into the test and have to be re-copied whenever it changed.
 */
describe("syntax inks are derived from the terminal's own ANSI slots", () => {
  // A dark ground with a light foreground and generous headroom, so every slot below
  // clears the floor untouched and any difference in the output is the mapping rather
  // than a correction.
  const BASE: ITheme = {
    background: "#101010",
    foreground: "#e0e0e0",
    cursor: "#ffffff",
    brightBlack: "#8a8a8a",
    green: "#7fd68a",
    blue: "#7fb0ff",
    magenta: "#d79cff",
    cyan: "#7fe0e0",
  };

  const SLOT_TO_TOKEN = [
    ["brightBlack", "--assistant-syntax-comment"],
    ["green", "--assistant-syntax-string"],
    ["blue", "--assistant-syntax-function"],
    ["magenta", "--assistant-syntax-keyword"],
    ["cyan", "--assistant-syntax-number"],
  ] as const;

  for (const [slot, token] of SLOT_TO_TOKEN) {
    it(`routes ANSI ${slot} to ${token}, and nothing else`, () => {
      const before = buildAssistantPalette(resolveInputBarColors(BASE), BASE);
      // A different hue, still with plenty of headroom on this ground, so the change
      // cannot be swallowed by a contrast correction.
      const changed: ITheme = { ...BASE, [slot]: "#ff9d5c" };
      const after = buildAssistantPalette(resolveInputBarColors(changed), changed);

      expect(after[token], `${token} ignored ANSI ${slot}`).not.toBe(before[token]);

      for (const [, other] of SLOT_TO_TOKEN) {
        if (other === token) continue;
        expect(after[other], `${other} moved when only ANSI ${slot} changed`).toBe(before[other]);
      }
    });
  }

  it("keeps every syntax role DISTINCT when the theme gives distinct slots", () => {
    // Five roles collapsing to one value is the failure the floors cannot see: it is
    // perfectly legible and carries no information.
    const palette = buildAssistantPalette(resolveInputBarColors(BASE), BASE);
    const inks = SLOT_TO_TOKEN.map(([, token]) => palette[token]);
    expect(new Set(inks).size).toBe(SLOT_TO_TOKEN.length);
  });

  it("still clears the text floor when a slot is POISONED to the ground", () => {
    // A custom scheme whose green equals its background. The correction has to rescue
    // it, because a comment painted in the background colour is an invisible line of
    // source that the reader has no way to know is there.
    const poisoned: ITheme = { ...BASE, green: BASE.background, brightBlack: BASE.background };
    const palette = buildAssistantPalette(resolveInputBarColors(poisoned), poisoned);
    for (const token of ["--assistant-syntax-string", "--assistant-syntax-comment"] as const) {
      for (const ground of GROUNDS) {
        expect(
          contrast(parse(palette[token]!), parse(palette[ground]!)),
          `${token} on ${ground}`
        ).toBeGreaterThanOrEqual(TEXT - 1e-9);
      }
    }
  });

  it("emits a complete, legible palette when the ANSI half is omitted entirely", () => {
    // `ansi` is optional, so this path is reachable by construction. It must degrade to
    // the panel's own derived colours rather than to `undefined` reaching the CSS.
    const palette = buildAssistantPalette(resolveInputBarColors(BASE));
    for (const tier of TEXT_TIERS) {
      expect(palette[tier], `${tier} missing without ANSI`).toMatch(/^#[0-9a-f]{6}$/);
      for (const ground of GROUNDS) {
        expect(
          contrast(parse(palette[tier]!), parse(palette[ground]!)),
          `${tier} on ${ground}`
        ).toBeGreaterThanOrEqual(TEXT - 1e-9);
      }
    }
  });
});

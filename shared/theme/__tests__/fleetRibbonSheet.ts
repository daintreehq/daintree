import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// fleet-ribbon.css as the ribbon's two suites read it: fleetRibbonContrast
// holds the fill and ink to their floors, and fleetDesignInvariants holds the
// ribbon to painting with them. Reading the sheet in one place is what keeps
// the colours one measures the colours the other requires.

export const FLEET_RIBBON_FILL = "--fleet-ribbon-fill";
export const FLEET_RIBBON_INK = "--fleet-ribbon-ink";

/** `oklch(from amber L C h)`, or the canvas's lightness stepped toward amber with chroma set from it. */
export type FleetRibbonDerivation =
  | { kind: "fixed"; l: number; c: number }
  | { kind: "canvas-step"; amberShare: number; chromaPerLightness: number };

// Comments go first, so nothing commented out can stand in for a declaration.
const css = readFileSync(
  resolve(__dirname, "../../../src/styles/components/fleet-ribbon.css"),
  "utf-8"
).replace(/\/\*[\s\S]*?\*\//g, "");

function derivation(body: string, variable: string): FleetRibbonDerivation {
  const raw = body.match(new RegExp(`${variable}:([^;]+);`))?.[1];
  if (raw === undefined) throw new Error(`${variable} not found in fleet-ribbon.css`);
  const value = raw.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

  const fixed = value.match(/^oklch\(from var\(--color-category-amber\) ([\d.]+) ([\d.]+) h\)$/);
  if (fixed) return { kind: "fixed", l: Number(fixed[1]), c: Number(fixed[2]) };

  const step = value.match(
    /^oklch\(from color-mix\(in oklab, var\(--color-category-amber\) ([\d.]+)%, oklch\(from var\(--color-surface-canvas\) l 0 0\)\) l calc\(l \* ([\d.]+)\) h\)$/
  );
  if (step) {
    return {
      kind: "canvas-step",
      amberShare: Number(step[1]) / 100,
      chromaPerLightness: Number(step[2]),
    };
  }
  throw new Error(`${variable} has a derivation the ribbon's tests cannot model: ${value}`);
}

const base = css.match(/^\.([\w-]+)\s*\{([^}]*)\}/m);
const surfaceClass = base?.[1];
const baseBody = base?.[2];
if (surfaceClass === undefined || baseBody === undefined) {
  throw new Error("fleet-ribbon.css has no surface rule");
}
// One paint declaration in the whole sheet, so no later rule or polarity can
// repaint the band with something the gate never measures.
const paints = Array.from(css.matchAll(/(?<![\w-])(background(?:-color)?)\s*:\s*([^;}]+)/gi));
const painted = baseBody.match(
  /(?<![\w-])background-color\s*:\s*var\((--[\w-]+)\)\s*(?:;|$)/i
)?.[1];
if (paints.length !== 1 || painted !== FLEET_RIBBON_FILL) {
  throw new Error(
    `the band must paint once, with the ${FLEET_RIBBON_FILL} its contrast gate measures; fleet-ribbon.css paints ${paints.map((m) => `${m[1]}: ${m[2]?.trim()}`).join(", ") || "nothing"}`
  );
}
const lightBody = css.match(
  new RegExp(
    `^:where\\(\\.light,\\s*\\[data-color-mode="light"\\]\\)\\s+\\.${surfaceClass}\\s*\\{([^}]*)\\}`,
    "m"
  )
)?.[1];
if (lightBody === undefined) throw new Error("fleet-ribbon.css has no light rule");

export const fleetRibbonSheet = {
  /** The class whose rule paints the band. */
  surfaceClass,
  /** Every custom property the sheet declares. */
  variables: new Set(Array.from(css.matchAll(/(--[\w-]+):/g), (m) => m[1] ?? "")),
  derivations: {
    dark: {
      fill: derivation(baseBody, FLEET_RIBBON_FILL),
      ink: derivation(baseBody, FLEET_RIBBON_INK),
    },
    light: {
      fill: derivation(lightBody, FLEET_RIBBON_FILL),
      ink: derivation(lightBody, FLEET_RIBBON_INK),
    },
  },
} as const;

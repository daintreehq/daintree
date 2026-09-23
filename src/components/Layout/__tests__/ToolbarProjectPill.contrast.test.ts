import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { BUILT_IN_APP_SCHEMES, getAppThemeCssVariables } from "@shared/theme/themes";
import { blendOverBackground, contrastRatio, parseRgba } from "@shared/theme/contrast";

// The branch chip sits on a stack of translucent layers — toolbar surface, pill
// wash, the hover/armed overlay, the chip's own wash — so its contrast is only
// knowable composited. This resolves each layer from the stylesheet and the
// theme's own variables, the way the browser does, and holds the branch to
// WCAG 1.4.3's 4.5:1 in every state the pill can be in, in every theme.

const CSS = fs.readFileSync(
  path.resolve(__dirname, "../../../styles/components/toolbar.css"),
  "utf-8"
);

type Vars = Record<string, string>;

/** Split a selector list on commas outside parentheses (`:where(a, b)` is one selector). */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

/** The declaration value of `prop` in the first rule whose selector list includes `selector`. */
function declaration(selector: string, prop: string): string {
  for (const match of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = splitTopLevel(match[1]!.replace(/\/\*[\s\S]*?\*\//g, ""));
    if (!selectors.includes(selector)) continue;
    const decl = new RegExp(`(?:^|;|\\s)${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+);`).exec(
      match[2]!
    );
    if (decl) return decl[1]!.trim();
  }
  throw new Error(`no ${prop} for ${selector} in toolbar.css`);
}

/** Resolve `var(--a, var(--b, #fff))` against a theme's variables. */
function resolve(expr: string, vars: Vars): string | undefined {
  const trimmed = expr.trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(trimmed);
  if (!m) return trimmed;
  const own = vars[m[1]!];
  if (own !== undefined) return own;
  return m[2] !== undefined ? resolve(m[2], vars) : undefined;
}

function toLayer(color: string): { hex: string; opacity: number } {
  const rgba = parseRgba(color);
  if (rgba) return rgba;
  if (/^#[0-9a-f]{6}$/i.test(color.trim())) return { hex: color.trim(), opacity: 1 };
  throw new Error(`unparseable colour: ${color}`);
}

function over(color: string, bg: string): string {
  const { hex, opacity } = toLayer(color);
  return blendOverBackground(hex, bg, opacity);
}

/** A gradient has no single colour, so the pill fill is every stop it can paint. */
function pillFills(bg: string, surface: string): string[] {
  const grad = /^linear-gradient\(([\s\S]*)\)\s*(?:,\s*([\s\S]+))?$/.exec(bg.trim());
  if (!grad) return [over(bg, surface)];
  const base = grad[2] ? over(grad[2], surface) : surface;
  const stops = grad[1]!.match(/rgba?\([^)]*\)|#[0-9a-f]{6}/gi) ?? [];
  return stops.map((stop) => over(stop, base));
}

const STATES = ["rest", "hover", "open"] as const;

function chipContrast(vars: Vars, isLight: boolean, state: (typeof STATES)[number]): number {
  const surface = resolve("var(--toolbar-bg, var(--theme-surface-toolbar))", vars)!;
  const fills = pillFills(resolve(declaration(".toolbar-project-pill", "--_bg"), vars)!, surface);
  const overlaySelector = isLight
    ? ':where(.light, [data-color-mode="light"]) .toolbar-project-pill[aria-expanded="true"]::before'
    : '.toolbar-project-pill[aria-expanded="true"]::before';
  const overlay =
    state === "rest"
      ? undefined
      : resolve(
          declaration(
            state === "hover" ? ".toolbar-project-pill::before" : overlaySelector,
            "background"
          ),
          vars
        );
  const fgExpr =
    state === "rest"
      ? declaration(".toolbar-project-chip", "--_fg")
      : declaration('.toolbar-project-pill[aria-expanded="true"] .toolbar-project-chip', "--_fg");
  const fg = toLayer(resolve(fgExpr, vars)!).hex;
  const chip = resolve(declaration(".toolbar-project-chip", "--_bg"), vars)!;

  return Math.min(
    ...fills.map((fill) => {
      const lifted = overlay ? over(overlay, fill) : fill;
      return contrastRatio(fg, over(chip, lifted));
    })
  );
}

describe("toolbar project pill — branch chip contrast", () => {
  for (const scheme of BUILT_IN_APP_SCHEMES) {
    it(`clears 4.5:1 at rest, hovered and open — ${scheme.id}`, () => {
      const vars = getAppThemeCssVariables(scheme);
      for (const state of STATES) {
        const ratio = chipContrast(vars, scheme.type === "light", state);
        expect(ratio, `${scheme.id} ${state}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("lifts the chip in hover as well as in the armed states", () => {
    // Hover shares the armed rule's lifted foreground; the parity is what the
    // per-theme loop above relies on when it reads the armed selector for both.
    expect(declaration(".toolbar-project-pill:hover .toolbar-project-chip", "--_fg")).toBe(
      declaration('.toolbar-project-pill[aria-expanded="true"] .toolbar-project-chip', "--_fg")
    );
  });
});

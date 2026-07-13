import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ACCENT_CONTRAST_PAIR } from "@shared/theme";

// Contrast validation (shared/theme/contrast.ts) checks abstract theme tokens: it
// guarantees `accent-foreground` clears 4.5:1 on `accent-primary`. It cannot see which
// Tailwind class a component actually paints on an accent fill, so a component reaching
// for `text-text-inverse` (keyed to the theme's *body text* polarity, not the accent)
// stays invisible to it — a custom accent can pass validation and still ship an
// unreadable CTA. That is #11115.
//
// This guard closes the loop the validator structurally cannot: it resolves every color
// utility through src/index.css's real variable graph and asserts that anything painting
// text on a solid accent fill lands on the same terminal token the validator checks.
//
// Nothing here is a hardcoded class name. The tokens come from the validator's own pair,
// and the classes that reach them are derived from the CSS graph — so the guard accepts
// any spelling that resolves correctly, rejects any that does not, and breaks loudly if
// the pair is renamed or its threshold removed.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");

const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

// Derived from the validator, not restated. Renaming the pair or dropping it from
// CONTRAST_PAIRS makes this guard fail rather than silently stop guarding.
const ACCENT_FILL_TOKEN = `--theme-${ACCENT_CONTRAST_PAIR.background}`;
const ACCENT_FOREGROUND_TOKEN = `--theme-${ACCENT_CONTRAST_PAIR.foreground}`;

const FOREGROUND_PREFIXES = ["text-", "fill-", "stroke-"];
const GRADIENT_STOP_PREFIXES = ["from-", "via-", "to-"];
// A gradient only paints once a gradient image utility is active; bare `from-*` is inert.
const GRADIENT_IMAGE = /^bg-(gradient-|linear-|radial|conic)/;
// `bg-cover`, `bg-center`, `bg-clip-*`, `bg-no-repeat` — background utilities that paint
// no color, so they never shield a descendant from an ancestor's accent fill.
const CLASS_CONSTRUCTORS = new Set(["cn", "clsx", "cx", "classNames", "twMerge", "twJoin"]);
const CVA_CONSTRUCTORS = new Set(["cva", "tv"]);
// A literal color escapes the token system: it can never be the validated token.
const LITERAL_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\()/i;
const MAX_FEASIBLE_SETS = 512;

// ── CSS variable graph ─────────────────────────────────────────────────

/** Every `--name: value` in index.css, in document order — later wins, as the cascade does. */
function parseCssVariables(css: string): Map<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = new Map<string, string>();
  for (const [, name, value] of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    if (name === undefined || value === undefined) continue;
    declarations.set(name, value.trim());
  }
  return declarations;
}

/**
 * Follow a variable through pure `var(--x)` aliases to the name it ultimately points at.
 * Stops at a `--theme-*` semantic token (the runtime theme supplies its value, and it is
 * the vocabulary the contrast validator speaks), or at any value that is not a bare alias.
 */
function resolveToTerminalToken(name: string, declarations: Map<string, string>): string {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
    if (current.startsWith("--theme-")) return current;
    seen.add(current);
    const value = declarations.get(current);
    if (value === undefined) return current;
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    if (alias?.[1] === undefined) return current;
    current = alias[1];
  }
  return current;
}

type ColorGraph = {
  /** Terminal token for a Tailwind color name, e.g. "primary" -> "--theme-accent-primary". */
  terminalOfName: (colorName: string) => string | null;
  /** Terminal token for a raw CSS variable, e.g. "--color-primary" / "--theme-accent-primary". */
  terminalOfVar: (varName: string) => string;
};

function buildColorGraph(css: string): ColorGraph {
  const declarations = parseCssVariables(css);
  return {
    terminalOfName(colorName) {
      const varName = `--color-${colorName}`;
      return declarations.has(varName) ? resolveToTerminalToken(varName, declarations) : null;
    },
    terminalOfVar(varName) {
      return resolveToTerminalToken(varName, declarations);
    },
  };
}

// ── Utility parsing ────────────────────────────────────────────────────

type Util = {
  raw: string;
  /** Variant chain (`hover`, `data-[state=on]`, `before`), normalized, order-insensitive. */
  variants: string[];
  /** The utility with variants, `!` and any opacity modifier removed. */
  base: string;
  /** The `/50` or `/[.5]` modifier, if present. */
  opacity: string | null;
};

/** Index of `ch` at bracket/paren depth zero, or -1. */
function indexAtDepthZero(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function parseUtil(raw: string): Util {
  // Tailwind v4 `bg-primary!` and v3 `!bg-primary`.
  let rest = raw.endsWith("!") ? raw.slice(0, -1) : raw;
  if (rest.startsWith("!")) rest = rest.slice(1);

  const variants: string[] = [];
  for (;;) {
    const cut = indexAtDepthZero(rest, ":");
    if (cut === -1) break;
    variants.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }

  // A slash inside `[...]` or `(...)` is part of the value (`bg-[url(a/b.png)]`,
  // `w-[calc(1/2)]`); only a depth-zero slash is an opacity modifier. Variant names can
  // also carry slashes (`group-hover/icon:`) — already stripped above.
  const slash = indexAtDepthZero(rest, "/");
  const base = slash === -1 ? rest : rest.slice(0, slash);
  const opacity = slash === -1 ? null : rest.slice(slash + 1);

  return { raw, variants, base, opacity };
}

/** A pseudo-element paints a separate box — neither the element's fill nor its own text. */
function isPseudoElement(util: Util): boolean {
  return util.variants.some((v) => v === "before" || v === "after");
}

/**
 * The terminal token a color-bearing utility resolves to, `"literal"` for a hardcoded
 * color that escapes the token system, or null when the utility is not a color at all
 * (`text-sm`, `text-center`, `text-[9px]`, `bg-cover`).
 */
function colorTerminal(base: string, prefix: string, graph: ColorGraph): string | null {
  const value = base.slice(prefix.length);

  const arbitrary = /^\[(.+)]$/.exec(value);
  if (arbitrary?.[1] !== undefined) {
    // A type hint is allowed: text-[color:var(--x)].
    const inner = arbitrary[1].replace(/^color:/, "");
    const varRef = /^var\(\s*(--[\w-]+)\s*\)$/.exec(inner);
    if (varRef?.[1] !== undefined) return graph.terminalOfVar(varRef[1]);
    if (LITERAL_COLOR.test(inner)) return "literal";
    return null;
  }

  if (value === "white" || value === "black") return "literal";
  // Inherits or paints nothing — not a determinable foreground of its own.
  if (value === "transparent" || value === "current" || value === "inherit") return null;

  return graph.terminalOfName(value);
}

/** A solid, unconditional-in-this-state accent fill behind the element's own text. */
function accentFills(utils: Util[], graph: ColorGraph): Util[] {
  const hasGradientImage = utils.some((u) => GRADIENT_IMAGE.test(u.base));
  return utils.filter((u) => {
    if (isPseudoElement(u)) return false;

    if (u.base.startsWith("bg-")) {
      // An opacity-modified fill is a wash over the surface, not solid accent.
      if (u.opacity !== null) return false;
      return colorTerminal(u.base, "bg-", graph) === ACCENT_FILL_TOKEN;
    }

    // Gradient stops only paint when a gradient image utility is active. A stop keeps
    // showing accent even at reduced alpha, so opacity does not disqualify it.
    const stop = GRADIENT_STOP_PREFIXES.find((p) => u.base.startsWith(p));
    if (stop === undefined || !hasGradientImage) return false;
    return colorTerminal(u.base, stop, graph) === ACCENT_FILL_TOKEN;
  });
}

/**
 * Does this class set repaint its own background, shielding its text from an ancestor's
 * accent fill? Only an unconditional, fully opaque, actually-colored background does.
 * A `hover:` background leaves the base state on the accent; an opacity-modified one is
 * translucent; and `bg-cover` paints no color at all.
 */
function shieldsBackground(utils: Util[], graph: ColorGraph): boolean {
  const hasGradientImage = utils.some((u) => GRADIENT_IMAGE.test(u.base));
  return utils.some((u) => {
    if (u.variants.length > 0 || u.opacity !== null) return false;
    if (u.base.startsWith("bg-")) return colorTerminal(u.base, "bg-", graph) !== null;
    const stop = GRADIENT_STOP_PREFIXES.find((p) => u.base.startsWith(p));
    if (stop === undefined || !hasGradientImage) return false;
    return colorTerminal(u.base, stop, graph) !== null;
  });
}

type Foreground = { util: Util; terminal: string };

function foregrounds(utils: Util[], graph: ColorGraph): Foreground[] {
  const out: Foreground[] = [];
  for (const util of utils) {
    if (isPseudoElement(util)) continue;
    const prefix = FOREGROUND_PREFIXES.find((p) => util.base.startsWith(p));
    if (prefix === undefined) continue;
    const terminal = colorTerminal(util.base, prefix, graph);
    if (terminal === null) continue;
    out.push({ util, terminal });
  }
  return out;
}

/**
 * The foreground actually painted while `fillVariants` is the active state. A foreground
 * applies if its own variant chain is satisfied in that state — a base `text-*` applies
 * always, a `hover:text-*` only once `hover` is active. The most specific wins, matching
 * how the cascade resolves them; a later declaration breaks a tie.
 */
function effectiveForeground(
  utils: Util[],
  fillVariants: string[],
  graph: ColorGraph
): Foreground | null {
  const active = new Set(fillVariants);
  let best: Foreground | null = null;
  for (const fg of foregrounds(utils, graph)) {
    if (!fg.util.variants.every((v) => active.has(v))) continue;
    if (best === null || fg.util.variants.length >= best.util.variants.length) best = fg;
  }
  return best;
}

/** The 4.5:1 guarantee covers the opaque token; alpha below 1 is no longer guaranteed. */
function isValidated(fg: Foreground): boolean {
  return fg.terminal === ACCENT_FOREGROUND_TOKEN && fg.util.opacity === null;
}

// ── Feasible class sets ────────────────────────────────────────────────

// A className is rarely one string. `cn("a", cond ? "b" : "c", flag && "d")` renders one
// of several class sets, and only classes that can co-occur may be compared: flattening
// them into one union would pair an accent fill from one ternary branch with a foreground
// from the other and report a bug that cannot happen. So expand the expression into the
// sets that can actually render, and check each independently.

function tokensOf(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

function crossProduct(groups: string[][][]): string[][] {
  let acc: string[][] = [[]];
  for (const group of groups) {
    const next: string[][] = [];
    for (const prefix of acc) {
      for (const suffix of group) next.push([...prefix, ...suffix]);
    }
    if (next.length > MAX_FEASIBLE_SETS) {
      // Degrade to the flat union rather than exploding. Over-approximates (may pair
      // classes that never co-occur), which can only over-report, never under-report.
      return [[...new Set(next.flat())]];
    }
    acc = next;
  }
  return acc;
}

function feasibleSets(node: ts.Node | undefined): string[][] {
  if (node === undefined) return [[]];

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [tokensOf(node.text)];
  }
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) {
    return feasibleSets(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [...feasibleSets(node.whenTrue), ...feasibleSets(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    // `flag && "cls"` renders the classes or nothing.
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [...feasibleSets(node.right), []];
    }
    if (
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.PlusToken
    ) {
      return [...feasibleSets(node.left), ...feasibleSets(node.right)];
    }
    return [[]];
  }
  if (ts.isTemplateExpression(node)) {
    const groups: string[][][] = [[tokensOf(node.head.text)]];
    for (const span of node.templateSpans) {
      groups.push(feasibleSets(span.expression), [tokensOf(span.literal.text)]);
    }
    return crossProduct(groups);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return crossProduct(node.elements.map((e) => feasibleSets(e)));
  }
  if (ts.isObjectLiteralExpression(node)) {
    // clsx's object form: each key is independently present or absent.
    return crossProduct(
      node.properties.flatMap((prop) => {
        if (!ts.isPropertyAssignment(prop)) return [];
        const name = prop.name;
        const text = ts.isStringLiteral(name)
          ? name.text
          : ts.isIdentifier(name)
            ? name.text
            : null;
        if (text === null) return [];
        return [[tokensOf(text), []]];
      })
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : null;
    if (callee !== null && CLASS_CONSTRUCTORS.has(callee)) {
      return crossProduct(node.arguments.map((arg) => feasibleSets(arg)));
    }
    return [[]];
  }
  // An identifier, member access, or anything else we cannot resolve statically.
  return [[]];
}

function parseSets(sets: string[][]): Util[][] {
  return sets.map((set) => set.map(parseUtil));
}

// ── Source analysis ────────────────────────────────────────────────────

export type Violation = { file: string; line: number; utility: string; context: string };

function classNameExprOf(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): ts.Node | undefined {
  for (const prop of element.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === "className") return prop.initializer;
  }
  return undefined;
}

/** Renders characters of its own — as opposed to rendering only child elements. */
function rendersText(child: ts.JsxChild): boolean {
  if (ts.isJsxText(child)) return child.text.trim().length > 0;
  if (!ts.isJsxExpression(child) || child.expression === undefined) return false;
  // `{done && <Check />}` renders an element, not text. `{count}` renders text.
  let hasJsx = false;
  const look = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJsx = true;
    ts.forEachChild(n, look);
  };
  look(child.expression);
  return !hasJsx;
}

/** A glyph that inherits `currentColor` — an icon component or a raw <svg>. */
function isGlyph(element: ts.JsxSelfClosingElement): boolean {
  const tag = element.tagName.getText();
  return tag === "svg" || /^[A-Z]/.test(tag);
}

type Analysis = { violations: Violation[]; accentSurfaces: number };

function analyzeSource(fileName: string, sourceText: string, graph: ColorGraph): Analysis {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  const violations: Violation[] = [];
  const seen = new Set<string>();
  let accentSurfaces = 0;

  // One element can carry several accent fills (a gradient's `from-` and `to-` stops are
  // both accent), and each would otherwise re-report the same offending foreground.
  const report = (node: ts.Node, utility: string, context: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const key = `${line}:${utility}:${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file: fileName, line, utility, context });
  };

  const utilsOf = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Util[][] =>
    parseSets(feasibleSets(classNameExprOf(element)));

  // Walk an accent-filled element's subtree. Text inherits the nearest foreground set by
  // an ancestor, so carry it down; a descendant that repaints its background is off the
  // accent and ends the descent.
  const walkSubtree = (
    children: readonly ts.JsxChild[],
    fillVariants: string[],
    inherited: Foreground | null
  ): void => {
    for (const child of children) {
      if (rendersText(child)) {
        if (inherited === null) {
          report(
            child,
            "(inherited)",
            "renders text on an accent fill with no accent foreground — inherits body-text color"
          );
        }
        continue;
      }

      const element = ts.isJsxElement(child)
        ? child
        : ts.isJsxSelfClosingElement(child)
          ? child
          : null;

      if (element === null) {
        // A fragment or an expression wrapping elements — keep looking inside it.
        if (ts.isJsxFragment(child)) walkSubtree(child.children, fillVariants, inherited);
        else if (ts.isJsxExpression(child) && child.expression !== undefined) {
          const nested: ts.JsxChild[] = [];
          const collect = (n: ts.Node): void => {
            if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
              nested.push(n);
              return;
            }
            ts.forEachChild(n, collect);
          };
          collect(child.expression);
          walkSubtree(nested, fillVariants, inherited);
        }
        continue;
      }

      const opening = ts.isJsxElement(element) ? element.openingElement : element;
      const sets = utilsOf(opening);
      if (sets.some((utils) => shieldsBackground(utils, graph))) continue;

      // A descendant's own foreground overrides what it inherits from the accent element.
      let here = inherited;
      for (const utils of sets) {
        const own = effectiveForeground(utils, fillVariants, graph);
        if (own === null) continue;
        if (!isValidated(own)) {
          report(opening, own.util.raw, "text painted on an ancestor's accent fill");
        }
        here = own;
      }

      if (ts.isJsxSelfClosingElement(element)) {
        if (here === null && isGlyph(element)) {
          report(
            opening,
            "(inherited)",
            "glyph on an accent fill with no accent foreground — inherits body-text color"
          );
        }
        continue;
      }
      walkSubtree(element.children, fillVariants, here);
    }
  };

  const checkElement = (element: ts.JsxElement | ts.JsxSelfClosingElement): void => {
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    for (const utils of utilsOf(opening)) {
      const fills = accentFills(utils, graph);
      if (fills.length === 0) continue;
      accentSurfaces++;

      for (const fill of fills) {
        const own = effectiveForeground(utils, fill.variants, graph);
        if (own !== null && !isValidated(own)) {
          report(opening, own.util.raw, "text painted on this element's accent fill");
        }
        if (ts.isJsxElement(element)) walkSubtree(element.children, fill.variants, own);
      }
    }
  };

  // cva/tv: the base classes apply to EVERY variant, so a foreground in the base and a
  // fill in a variant do co-occur. Pair the base with each variant string in turn.
  const checkCva = (call: ts.CallExpression): void => {
    const [baseArg, config] = call.arguments;
    const baseSets = parseSets(feasibleSets(baseArg));
    const variantLiterals: ts.StringLiteralLike[] = [];
    if (config !== undefined) {
      const collect = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) variantLiterals.push(n);
        ts.forEachChild(n, collect);
      };
      collect(config);
    }

    const combos: Array<{ node: ts.Node; utils: Util[] }> = [];
    for (const base of baseSets) {
      if (variantLiterals.length === 0) combos.push({ node: call, utils: base });
      for (const literal of variantLiterals) {
        combos.push({ node: literal, utils: [...base, ...tokensOf(literal.text).map(parseUtil)] });
      }
    }

    for (const { node, utils } of combos) {
      const fills = accentFills(utils, graph);
      if (fills.length === 0) continue;
      accentSurfaces++;
      for (const fill of fills) {
        const own = effectiveForeground(utils, fill.variants, graph);
        if (own !== null && !isValidated(own)) {
          report(node, own.util.raw, "text painted on an accent fill in a class-variant string");
        }
        if (own === null) {
          report(
            node,
            "(inherited)",
            "accent-filled variant sets no accent foreground — text inherits body-text color"
          );
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) checkElement(node);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CVA_CONSTRUCTORS.has(node.expression.text)
    ) {
      checkCva(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { violations, accentSurfaces };
}

// ── File collection ────────────────────────────────────────────────────

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") return [];
      return collectSourceFiles(fullPath);
    }
    if (!entry.name.endsWith(".tsx")) return [];
    if (entry.name.includes(".test.") || entry.name.includes(".stories.")) return [];
    return [fullPath];
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

const graph = buildColorGraph(fs.readFileSync(INDEX_CSS_PATH, "utf-8"));

describe("accent color graph", () => {
  // If the wiring is renamed and these resolve nowhere, every scan below would pass
  // vacuously. Pin both ends of the graph the whole guard is built on.
  it("resolves the shadcn and daintree fill aliases to the validated fill token", () => {
    expect(graph.terminalOfName("primary")).toBe(ACCENT_FILL_TOKEN);
    expect(graph.terminalOfName("daintree-accent")).toBe(ACCENT_FILL_TOKEN);
    expect(graph.terminalOfName("accent-primary")).toBe(ACCENT_FILL_TOKEN);
  });

  it("resolves every accent foreground alias to the validated foreground token", () => {
    expect(graph.terminalOfName("primary-foreground")).toBe(ACCENT_FOREGROUND_TOKEN);
    expect(graph.terminalOfName("accent-primary-foreground")).toBe(ACCENT_FOREGROUND_TOKEN);
    // Once shadowed by a duplicate shadcn declaration that silently pointed it at body
    // text (#11115). It must reach the validated token, or not exist at all.
    const accentForeground = graph.terminalOfName("accent-foreground");
    if (accentForeground !== null) expect(accentForeground).toBe(ACCENT_FOREGROUND_TOKEN);
  });

  it("does not resolve the body-text foregrounds to the accent foreground token", () => {
    expect(graph.terminalOfName("text-inverse")).not.toBe(ACCENT_FOREGROUND_TOKEN);
    expect(graph.terminalOfName("daintree-bg")).not.toBe(ACCENT_FOREGROUND_TOKEN);
  });
});

describe("utility parser", () => {
  it("splits an opacity modifier only at bracket depth zero", () => {
    expect(parseUtil("bg-daintree-accent/10")).toMatchObject({
      base: "bg-daintree-accent",
      opacity: "10",
    });
    expect(parseUtil("text-text-inverse/[.5]")).toMatchObject({
      base: "text-text-inverse",
      opacity: "[.5]",
    });
    // Slashes inside an arbitrary value belong to the value, not to an opacity modifier.
    expect(parseUtil("bg-[url(a/b.png)]")).toMatchObject({
      base: "bg-[url(a/b.png)]",
      opacity: null,
    });
    expect(parseUtil("w-[calc(1/2)]")).toMatchObject({ base: "w-[calc(1/2)]", opacity: null });
  });

  it("strips variant chains without tripping on colons or slashes inside them", () => {
    expect(parseUtil("data-[state=checked]:bg-primary")).toMatchObject({
      variants: ["data-[state=checked]"],
      base: "bg-primary",
    });
    expect(parseUtil("supports-[display:grid]:bg-primary")).toMatchObject({
      variants: ["supports-[display:grid]"],
      base: "bg-primary",
    });
    // The slash lives in the variant name, not in an opacity modifier.
    expect(parseUtil("group-hover/icon:text-white")).toMatchObject({
      variants: ["group-hover/icon"],
      base: "text-white",
      opacity: null,
    });
    expect(parseUtil("hover:focus:bg-primary")).toMatchObject({ variants: ["hover", "focus"] });
  });

  it("strips the important modifier in both Tailwind spellings", () => {
    expect(parseUtil("bg-primary!").base).toBe("bg-primary");
    expect(parseUtil("!bg-primary").base).toBe("bg-primary");
  });
});

describe("accent foreground detector", () => {
  const analyze = (src: string): string[] =>
    analyzeSource("fixture.tsx", src, graph).violations.map((v) => v.utility);

  it("flags an unvalidated foreground in the same class string as an accent fill", () => {
    expect(
      analyze(`const x = <button className="bg-daintree-accent text-text-inverse" />;`)
    ).toEqual(["text-text-inverse"]);
  });

  it("flags a fill and foreground that only meet after composition", () => {
    // The bypass a per-literal check misses: neither string is a violation alone.
    expect(
      analyze(`const x = <button className={cn("text-text-inverse", active && "bg-primary")} />;`)
    ).toEqual(["text-text-inverse"]);
  });

  it("flags a cva base foreground against a fill introduced by a variant", () => {
    expect(
      analyze(`
        const v = cva("text-text-inverse", { variants: { tone: { accent: "bg-primary" } } });
      `)
    ).toEqual(["text-text-inverse"]);
  });

  it("does not pair classes from opposite ternary branches", () => {
    // The accent branch is validated; the neutral branch's dim text never lands on accent.
    expect(
      analyze(`
        const x = (
          <button
            className={cn(
              "px-4",
              enabled
                ? "bg-daintree-accent text-accent-primary-foreground"
                : "bg-daintree-border text-daintree-text/50"
            )}
          />
        );
      `)
    ).toEqual([]);
  });

  it("flags text that inherits body-text color on an accent fill", () => {
    expect(analyze(`const x = <button className="bg-primary">Save</button>;`)).toEqual([
      "(inherited)",
    ]);
    expect(analyze(`const x = <span className="bg-daintree-accent">{count}</span>;`)).toEqual([
      "(inherited)",
    ]);
  });

  it("flags a glyph that inherits body-text color on an accent fill", () => {
    expect(analyze(`const x = <div className="bg-daintree-accent"><Check /></div>;`)).toEqual([
      "(inherited)",
    ]);
  });

  it("accepts a decorative accent fill that renders nothing", () => {
    expect(analyze(`const x = <div className="h-1 w-full bg-daintree-accent" />;`)).toEqual([]);
  });

  it("flags a child glyph painted on an ancestor's accent fill", () => {
    expect(
      analyze(`
        const x = (
          <div className="rounded-full bg-daintree-accent">
            <Check className="h-2.5 w-2.5 text-daintree-bg" />
          </div>
        );
      `)
    ).toEqual(["text-daintree-bg"]);
  });

  it("flags a child glyph reached through a conditional expression", () => {
    expect(
      analyze(`
        const x = (
          <span className={cn("border", isSelected ? "bg-daintree-accent" : "border-daintree-border")}>
            {isSelected && <Check className="w-3 h-3 text-text-inverse" />}
          </span>
        );
      `)
    ).toEqual(["text-text-inverse"]);
  });

  it("accepts a child glyph that supplies the validated foreground itself", () => {
    expect(
      analyze(`
        const x = (
          <div className="bg-daintree-accent">
            {done && <Check className="text-accent-primary-foreground" />}
          </div>
        );
      `)
    ).toEqual([]);
  });

  it("matches a foreground to the state its fill is in", () => {
    // The accent only exists on hover, and hover repaints the label — safe.
    expect(
      analyze(
        `const x = <button className="text-daintree-text hover:bg-primary hover:text-primary-foreground" />;`
      )
    ).toEqual([]);
    // Same accent-on-hover, but the label is never repainted — the base text lands on it.
    expect(
      analyze(`const x = <button className="text-daintree-text hover:bg-primary">Go</button>;`)
    ).toEqual(["text-daintree-text"]);
  });

  it("ignores a pseudo-element's own fill and foreground", () => {
    expect(
      analyze(`const x = <div className="after:bg-daintree-accent text-daintree-text" />;`)
    ).toEqual([]);
    expect(
      analyze(
        `const x = <div className="bg-primary text-primary-foreground before:text-white before:content-['!']" />;`
      )
    ).toEqual([]);
  });

  it("flags an arbitrary-value foreground that escapes the validated token", () => {
    expect(
      analyze(`const x = <span className="bg-daintree-accent text-[var(--color-daintree-bg)]" />;`)
    ).toEqual(["text-[var(--color-daintree-bg)]"]);
    expect(
      analyze(
        `const x = <span className="bg-daintree-accent text-[color:var(--theme-text-primary)]" />;`
      )
    ).toEqual(["text-[color:var(--theme-text-primary)]"]);
    expect(analyze(`const x = <span className="bg-daintree-accent text-[#0b1220]" />;`)).toEqual([
      "text-[#0b1220]",
    ]);
  });

  it("flags hardcoded palette colors and alpha-reduced foregrounds on an accent fill", () => {
    expect(analyze(`const x = <button className="bg-primary text-white" />;`)).toEqual([
      "text-white",
    ]);
    // The 4.5:1 guarantee covers the opaque token — not a faded copy of it.
    expect(
      analyze(`const x = <button className="bg-primary text-primary-foreground/50" />;`)
    ).toEqual(["text-primary-foreground/50"]);
  });

  it("resolves an accent fill written as an arbitrary value", () => {
    expect(
      analyze(`const x = <button className="bg-[var(--color-accent-primary)] text-white" />;`)
    ).toEqual(["text-white"]);
  });

  it("accepts either validated foreground alias", () => {
    expect(analyze(`const x = <button className="bg-primary text-primary-foreground" />;`)).toEqual(
      []
    );
    expect(
      analyze(`const x = <button className="bg-daintree-accent text-accent-primary-foreground" />;`)
    ).toEqual([]);
  });

  it("ignores non-color text utilities on an accent fill", () => {
    expect(
      analyze(
        `const x = <button className="bg-primary text-accent-primary-foreground text-sm text-center text-[9px]" />;`
      )
    ).toEqual([]);
  });

  it("ignores tinted accent washes — the text sits on the surface, not on solid accent", () => {
    expect(
      analyze(`const x = <div className="bg-daintree-accent/10 text-daintree-text">Hi</div>;`)
    ).toEqual([]);
    expect(
      analyze(`const x = <div className="bg-accent-soft text-daintree-text">Hi</div>;`)
    ).toEqual([]);
  });

  it("only treats gradient stops as a fill when a gradient is actually painted", () => {
    expect(
      analyze(
        `const x = <button className="bg-gradient-to-b from-primary to-primary/80 text-text-inverse" />;`
      )
    ).toEqual(["text-text-inverse"]);
    // A later accent stop still paints accent under the label.
    expect(
      analyze(
        `const x = <button className="bg-gradient-to-b from-primary/80 to-primary text-white" />;`
      )
    ).toEqual(["text-white"]);
    // `from-*` without a gradient image paints nothing.
    expect(analyze(`const x = <div className="from-primary text-white">Hi</div>;`)).toEqual([]);
  });

  it("stops descending only at a descendant that truly repaints its background", () => {
    expect(
      analyze(`
        const x = (
          <div className="bg-daintree-accent">
            <div className="bg-surface-panel">
              <span className="text-daintree-text">safe — on the panel, not the accent</span>
            </div>
          </div>
        );
      `)
    ).toEqual([]);
    // A conditional background does not shield the base state.
    expect(
      analyze(`
        const x = (
          <div className="bg-primary">
            <span className="hover:bg-surface-panel text-text-inverse">bad before hover</span>
          </div>
        );
      `)
    ).toEqual(["text-text-inverse"]);
    // A translucent background does not shield either.
    expect(
      analyze(`
        const x = (
          <div className="bg-primary">
            <span className="bg-surface-panel/10 text-text-inverse">still on accent</span>
          </div>
        );
      `)
    ).toEqual(["text-text-inverse"]);
    // `bg-cover` paints no color at all.
    expect(
      analyze(`
        const x = (
          <div className="bg-primary">
            <span className="bg-cover text-text-inverse">paints no background</span>
          </div>
        );
      `)
    ).toEqual(["text-text-inverse"]);
  });
});

describe("accent foreground contract", () => {
  const filesByRoot = SCAN_ROOTS.map((root) => ({ root, files: collectSourceFiles(root) }));
  const files = filesByRoot.flatMap((r) => r.files);

  it("scans every root", () => {
    // Without this, a mistyped root would silently shrink the scan and still pass.
    for (const { root, files: rootFiles } of filesByRoot) {
      expect(rootFiles.length, `no .tsx files found under ${root}`).toBeGreaterThan(0);
    }
    expect(files.length).toBeGreaterThan(100);
  });

  const results = files.map((file) =>
    analyzeSource(path.relative(REPO_ROOT, file), fs.readFileSync(file, "utf-8"), graph)
  );

  it("actually finds accent surfaces to check", () => {
    // The assertion that makes a vacuous pass impossible: if the walker, the parser, or
    // the CSS graph silently stopped recognizing accent fills, the contract below would
    // pass with zero violations while every offender sailed through.
    const surfaces = results.reduce((sum, r) => sum + r.accentSurfaces, 0);
    expect(surfaces).toBeGreaterThan(10);
  });

  it("paints text on a solid accent fill only with the contrast-validated foreground", () => {
    const report = results
      .flatMap((r) => r.violations)
      .map((v) => `${v.file}:${v.line} — ${v.utility} (${v.context})`);

    expect(
      report,
      "Text on a solid accent fill must use a foreground resolving to " +
        `${ACCENT_FOREGROUND_TOKEN} (e.g. text-primary-foreground on bg-primary, ` +
        "text-accent-primary-foreground on bg-daintree-accent). Tokens like text-text-inverse " +
        "and text-daintree-bg are keyed to the theme's body-text polarity, not to the accent, " +
        "so the contrast validator never checks them against the accent fill (#11115)."
    ).toEqual([]);
  });
});

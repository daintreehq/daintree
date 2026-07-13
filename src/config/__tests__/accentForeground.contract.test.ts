import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ACCENT_CONTRAST_PAIR, BUILT_IN_APP_SCHEMES } from "@shared/theme";

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
// any spelling that resolves correctly and rejects any that does not.
//
// KNOWN LIMITS (deliberate — this is a regression guard, not a sound Tailwind checker):
//   - A className built by a call we cannot resolve (`getClasses(x)`, an imported
//     constant) is not analyzed. Local `const` string bindings ARE resolved, and a
//     whole-file literal sweep still catches a fill and a bad foreground sharing one
//     string wherever it is written.
//   - Classes flowing in through a `className` prop from a caller are not tracked across
//     components.
//   - Tailwind's generated source order can differ from class-attribute order when two
//     utilities set the same property. Rather than model that, ANY unvalidated foreground
//     that can coexist with an accent fill is reported, even if another class might win.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");

const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

// Derived from the validator, not restated.
const ACCENT_FILL_TOKEN = `--theme-${ACCENT_CONTRAST_PAIR.background}`;
const ACCENT_FOREGROUND_TOKEN = `--theme-${ACCENT_CONTRAST_PAIR.foreground}`;

// `text-`, `fill-` and `stroke-` set DIFFERENT CSS properties — they never override one
// another, so each is resolved on its own.
const FOREGROUND_PROPS: Array<{ prefix: string; property: string }> = [
  { prefix: "text-", property: "color" },
  { prefix: "fill-", property: "fill" },
  { prefix: "stroke-", property: "stroke" },
];
const GRADIENT_STOP_PREFIXES = ["from-", "via-", "to-"];
const GRADIENT_IMAGE = /^bg-(gradient-|linear-|radial|conic)/;
const CLASS_CONSTRUCTORS = new Set(["cn", "clsx", "cx", "classNames", "twMerge", "twJoin"]);
const LITERAL_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab|lab|lch|color)a?\()/i;
// An arbitrary value that is a length/number is a size, not a color: text-[9px], text-[2].
const LENGTH_VALUE = /^-?[\d.]+([a-z%]*)$/i;
const OPAQUE_MODIFIER = /^(100|\[1]|\[100%]|\[1\.0]) *$/;
const SOLID_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TEXT_BEARING_INTRINSICS = new Set(["input", "textarea", "select", "option"]);
// A checkbox or radio paints no text of its own — the UA draws its mark, which is
// graphical-object contrast (WCAG 1.4.11), not the text contrast this pair governs.
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "hidden",
  "image",
]);
const MAX_FEASIBLE_SETS = 512;

// ── CSS variable graph ─────────────────────────────────────────────────

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
 * Stops at a `--theme-*` semantic token — the vocabulary the contrast validator speaks —
 * or at any value that is not a bare alias.
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
  terminalOfName: (colorName: string) => string | null;
  terminalOfVar: (varName: string) => string;
  /** Is this terminal token opaque in EVERY built-in theme? Only then can it hide accent. */
  isOpaqueToken: (terminal: string) => boolean;
};

function buildColorGraph(css: string): ColorGraph {
  const declarations = parseCssVariables(css);
  // A token like `overlay-soft` is an rgba() wash in every theme — painting it over an
  // accent fill does not hide the accent, so it must not shield a descendant's text.
  const opaque = new Map<string, boolean>();
  const schemeTokens = BUILT_IN_APP_SCHEMES.map((scheme) => new Map(Object.entries(scheme.tokens)));
  for (const key of new Set(schemeTokens.flatMap((tokens) => [...tokens.keys()]))) {
    const solidEverywhere = schemeTokens.every((tokens) => {
      const value = tokens.get(key);
      return typeof value === "string" && SOLID_HEX.test(value);
    });
    opaque.set(`--theme-${key}`, solidEverywhere);
  }
  return {
    terminalOfName(colorName) {
      const varName = `--color-${colorName}`;
      return declarations.has(varName) ? resolveToTerminalToken(varName, declarations) : null;
    },
    terminalOfVar(varName) {
      return resolveToTerminalToken(varName, declarations);
    },
    isOpaqueToken(terminal) {
      if (terminal === "literal-opaque") return true;
      return opaque.get(terminal) ?? false;
    },
  };
}

// ── Utility parsing ────────────────────────────────────────────────────

type Util = {
  raw: string;
  variants: string[];
  base: string;
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
  let rest = raw.endsWith("!") ? raw.slice(0, -1) : raw;

  const variants: string[] = [];
  for (;;) {
    const cut = indexAtDepthZero(rest, ":");
    if (cut === -1) break;
    variants.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }

  // The v3 important prefix sits AFTER the variant chain: `hover:!bg-primary`.
  if (rest.startsWith("!")) rest = rest.slice(1);

  // A slash inside `[...]`/`(...)` belongs to the value (`bg-[url(a/b.png)]`,
  // `w-[calc(1/2)]`); only a depth-zero slash is an opacity modifier. Variant names can
  // carry slashes (`group-hover/icon:`) but those are already stripped above.
  const slash = indexAtDepthZero(rest, "/");
  const base = slash === -1 ? rest : rest.slice(0, slash);
  const modifier = slash === -1 ? null : rest.slice(slash + 1);
  // `/100` is fully opaque — not a wash.
  const opacity = modifier !== null && OPAQUE_MODIFIER.test(modifier) ? null : modifier;

  return { raw, variants, base, opacity };
}

function isPseudoElement(util: Util): boolean {
  return util.variants.some((v) => v === "before" || v === "after");
}

/**
 * The terminal token a color utility resolves to, `"literal-opaque"` for a hardcoded color
 * that escapes the token system, or null when the utility is not a color at all
 * (`text-sm`, `text-[9px]`, `bg-cover`).
 */
function colorTerminal(base: string, prefix: string, graph: ColorGraph): string | null {
  const value = base.slice(prefix.length);

  // Tailwind v4 shorthand for a CSS variable: bg-(--color-primary).
  const parenVar = /^\((--[\w-]+)\)$/.exec(value);
  if (parenVar?.[1] !== undefined) return graph.terminalOfVar(parenVar[1]);

  const arbitrary = /^\[(.+)]$/.exec(value);
  if (arbitrary?.[1] !== undefined) {
    const inner = arbitrary[1].replace(/^color:/, "").trim();
    const varRef = /^var\(\s*(--[\w-]+)[^)]*\)$/.exec(inner);
    if (varRef?.[1] !== undefined) return graph.terminalOfVar(varRef[1]);
    if (inner.startsWith("--")) return graph.terminalOfVar(inner);
    if (LENGTH_VALUE.test(inner)) return null;
    if (inner === "transparent" || inner === "currentColor" || inner === "inherit") return null;
    // A hex, an rgb()/hsl(), or a named color like `red` — a real color, but not the token.
    if (LITERAL_COLOR.test(inner) || /^[a-z]+$/i.test(inner)) return "literal-opaque";
    return null;
  }

  if (value === "white" || value === "black") return "literal-opaque";
  if (value === "transparent" || value === "current" || value === "inherit") return null;

  return graph.terminalOfName(value);
}

function accentFills(utils: Util[], graph: ColorGraph): Util[] {
  const hasGradientImage = utils.some((u) => GRADIENT_IMAGE.test(u.base));
  return utils.filter((u) => {
    if (isPseudoElement(u)) return false;
    if (u.base.startsWith("bg-")) {
      if (u.opacity !== null) return false; // a wash over the surface, not solid accent
      return colorTerminal(u.base, "bg-", graph) === ACCENT_FILL_TOKEN;
    }
    // Gradient stops paint only when a gradient image utility is active. A stop keeps
    // showing accent at reduced alpha, so opacity does not disqualify it.
    const stop = GRADIENT_STOP_PREFIXES.find((p) => u.base.startsWith(p));
    if (stop === undefined || !hasGradientImage) return false;
    return colorTerminal(u.base, stop, graph) === ACCENT_FILL_TOKEN;
  });
}

/**
 * Does this class set repaint its own background, hiding an ancestor's accent fill?
 * Only an unconditional, provably OPAQUE, actually-colored background does. A `hover:`
 * background leaves the base state on the accent; a translucent one (an opacity modifier,
 * or a wash token like `overlay-soft` whose theme value is rgba) still shows it; and
 * `bg-cover` paints no color at all.
 */
function shieldsBackground(utils: Util[], graph: ColorGraph): boolean {
  return utils.some((u) => {
    if (u.variants.length > 0 || u.opacity !== null) return false;
    if (!u.base.startsWith("bg-")) return false;
    const terminal = colorTerminal(u.base, "bg-", graph);
    if (terminal === null) return false;
    return graph.isOpaqueToken(terminal);
  });
}

type Foreground = { util: Util; property: string; terminal: string };

function foregroundsOf(utils: Util[], graph: ColorGraph): Foreground[] {
  const out: Foreground[] = [];
  for (const util of utils) {
    if (isPseudoElement(util)) continue;
    const match = FOREGROUND_PROPS.find((p) => util.base.startsWith(p.prefix));
    if (match === undefined) continue;
    const terminal = colorTerminal(util.base, match.prefix, graph);
    if (terminal === null) continue;
    out.push({ util, property: match.property, terminal });
  }
  return out;
}

/** The 4.5:1 guarantee covers the opaque token; alpha below 1 is no longer guaranteed. */
function isValidated(fg: Foreground): boolean {
  return fg.terminal === ACCENT_FOREGROUND_TOKEN && fg.util.opacity === null;
}

/**
 * Every foreground that can be painted while an accent fill with `fillVariants` is showing.
 *
 * A fill with variant chain V is painted in EVERY state that includes V — so a base
 * `bg-primary` is still there on hover, and a `hover:text-white` lands on it. Conversely a
 * foreground with chain W only applies in states including W. So V and W coexist in state
 * V ∪ W. Rather than model which of two same-property classes Tailwind emits last, report
 * any unvalidated foreground that can coexist with the fill — conservative in the safe
 * direction. A foreground is exempt only when a MORE specific one for the same property
 * overrides it in that state (`text-daintree-text hover:bg-primary hover:text-...`).
 */
function coexistingForegrounds(
  utils: Util[],
  fillVariants: string[],
  graph: ColorGraph
): { offending: Foreground[]; colorInState: Foreground | null } {
  const foregrounds = foregroundsOf(utils, graph);
  const offending: Foreground[] = [];

  for (const fg of foregrounds) {
    const state = new Set([...fillVariants, ...fg.util.variants]);
    // Something strictly more specific for the same property, also active here, wins.
    const overridden = foregrounds.some(
      (other) =>
        other !== fg &&
        other.property === fg.property &&
        other.util.variants.every((v) => state.has(v)) &&
        other.util.variants.length > fg.util.variants.length
    );
    if (overridden) continue;
    if (!isValidated(fg)) offending.push(fg);
  }

  // What paints the element's own text in the fill's exact state (null => it inherits).
  const active = new Set(fillVariants);
  let colorInState: Foreground | null = null;
  for (const fg of foregrounds) {
    if (fg.property !== "color") continue;
    if (!fg.util.variants.every((v) => active.has(v))) continue;
    if (colorInState === null || fg.util.variants.length >= colorInState.util.variants.length) {
      colorInState = fg;
    }
  }

  return { offending, colorInState };
}

// ── Feasible class sets ────────────────────────────────────────────────

// A className is rarely one string. `cn("a", cond ? "b" : "c", flag && "d")` renders one of
// several sets, and only classes that can co-occur may be compared: flattening them into
// one union would pair an accent fill from one ternary branch with a foreground from the
// other and report a bug that cannot happen. So expand the expression into the sets that
// can actually render — carrying each branch's predicate so that two ternaries on the SAME
// condition never produce an impossible combination — and check each set independently.

type ClassSet = { utils: Util[]; constraints: Map<string, boolean> };

function tokensOf(text: string): Util[] {
  return text
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(parseUtil);
}

function mergeSets(a: ClassSet, b: ClassSet): ClassSet | null {
  const constraints = new Map(a.constraints);
  for (const [key, value] of b.constraints) {
    const existing = constraints.get(key);
    if (existing !== undefined && existing !== value) return null; // contradiction
    constraints.set(key, value);
  }
  return { utils: [...a.utils, ...b.utils], constraints };
}

function crossProduct(groups: ClassSet[][]): ClassSet[] {
  let acc: ClassSet[] = [{ utils: [], constraints: new Map() }];
  for (const group of groups) {
    const next: ClassSet[] = [];
    for (const prefix of acc) {
      for (const suffix of group) {
        const merged = mergeSets(prefix, suffix);
        if (merged !== null) next.push(merged);
      }
    }
    // Refuse to guess past the cap rather than flattening to a union — a union can hide a
    // violation by letting a validated class from one branch cover an invalid one.
    if (next.length > MAX_FEASIBLE_SETS) {
      throw new Error("accent-foreground guard: className too complex to analyze");
    }
    acc = next;
  }
  return acc;
}

function withConstraint(sets: ClassSet[], key: string, value: boolean): ClassSet[] {
  const out: ClassSet[] = [];
  for (const set of sets) {
    const existing = set.constraints.get(key);
    if (existing !== undefined && existing !== value) continue;
    const constraints = new Map(set.constraints);
    constraints.set(key, value);
    out.push({ utils: set.utils, constraints });
  }
  return out;
}

const EMPTY_SET = (): ClassSet[] => [{ utils: [], constraints: new Map() }];

function feasibleSets(node: ts.Node | undefined, locals: Map<string, string>): ClassSet[] {
  if (node === undefined) return EMPTY_SET();

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ utils: tokensOf(node.text), constraints: new Map() }];
  }
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) {
    return feasibleSets(node.expression, locals);
  }
  if (ts.isIdentifier(node)) {
    // Resolve a local `const cls = "bg-primary text-white"` binding.
    const value = locals.get(node.text);
    if (value !== undefined) return [{ utils: tokensOf(value), constraints: new Map() }];
    return EMPTY_SET();
  }
  if (ts.isConditionalExpression(node)) {
    const key = node.condition.getText().replace(/\s+/g, "");
    return [
      ...withConstraint(feasibleSets(node.whenTrue, locals), key, true),
      ...withConstraint(feasibleSets(node.whenFalse, locals), key, false),
    ];
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const key = node.left.getText().replace(/\s+/g, "");
      return [
        ...withConstraint(feasibleSets(node.right, locals), key, true),
        ...withConstraint(EMPTY_SET(), key, false),
      ];
    }
    if (kind === ts.SyntaxKind.PlusToken) {
      // String concatenation — both sides render together.
      return crossProduct([feasibleSets(node.left, locals), feasibleSets(node.right, locals)]);
    }
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [...feasibleSets(node.left, locals), ...feasibleSets(node.right, locals)];
    }
    return EMPTY_SET();
  }
  if (ts.isTemplateExpression(node)) {
    const groups: ClassSet[][] = [[{ utils: tokensOf(node.head.text), constraints: new Map() }]];
    for (const span of node.templateSpans) {
      groups.push(feasibleSets(span.expression, locals));
      groups.push([{ utils: tokensOf(span.literal.text), constraints: new Map() }]);
    }
    return crossProduct(groups);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return crossProduct(node.elements.map((e) => feasibleSets(e, locals)));
  }
  if (ts.isObjectLiteralExpression(node)) {
    // clsx's object form: each key renders when its value is truthy.
    return crossProduct(
      node.properties.flatMap((prop) => {
        if (!ts.isPropertyAssignment(prop)) return [];
        const name = prop.name;
        const text = ts.isStringLiteral(name) || ts.isIdentifier(name) ? name.text : null;
        if (text === null) return [];
        const key = prop.initializer.getText().replace(/\s+/g, "");
        return [
          [
            { utils: tokensOf(text), constraints: new Map([[key, true]]) },
            { utils: [], constraints: new Map([[key, false]]) },
          ],
        ];
      })
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : null;
    if (callee !== null && CLASS_CONSTRUCTORS.has(callee)) {
      return crossProduct(node.arguments.map((arg) => feasibleSets(arg, locals)));
    }
    return EMPTY_SET();
  }
  return EMPTY_SET();
}

// ── Source analysis ────────────────────────────────────────────────────

export type Violation = { file: string; line: number; utility: string; context: string };
type Analysis = { violations: Violation[]; accentSurfaces: number };

function classNameExprOf(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): ts.Node | undefined {
  for (const prop of element.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === "className") return prop.initializer;
  }
  return undefined;
}

/** Local `const x = "…"` string bindings, so `className={x}` still resolves. */
function collectLocalStrings(source: ts.SourceFile): Map<string, string> {
  const locals = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      locals.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return locals;
}

/** Names imported from an icon package — they render a glyph inheriting `currentColor`. */
function collectGlyphNames(source: ts.SourceFile): Set<string> {
  const glyphs = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier;
    if (!ts.isStringLiteral(from)) continue;
    if (!/lucide-react|components\/icons/.test(from.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) glyphs.add(spec.name.text);
  }
  return glyphs;
}

function analyzeSource(fileName: string, sourceText: string, graph: ColorGraph): Analysis {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  const locals = collectLocalStrings(source);
  const glyphNames = collectGlyphNames(source);

  const violations: Violation[] = [];
  const seen = new Set<string>();
  const reportedUtilities = new Set<string>();
  let accentSurfaces = 0;

  // One element can carry several accent fills (a gradient's `from-` and `to-` stops are
  // both accent) and several feasible sets, and the literal sweep may re-find what the
  // structural pass already reported. Key on the offending class at its line, not on which
  // rule happened to catch it.
  const report = (node: ts.Node, utility: string, context: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const key = `${line}:${utility}`;
    if (seen.has(key)) return;
    seen.add(key);
    reportedUtilities.add(utility);
    violations.push({ file: fileName, line, utility, context });
  };

  const setsOf = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ClassSet[] =>
    feasibleSets(classNameExprOf(element), locals);

  const isGlyphElement = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean => {
    const tag = element.tagName.getText();
    return tag === "svg" || glyphNames.has(tag);
  };

  const attrText = (
    element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    name: string
  ): string | null => {
    for (const prop of element.attributes.properties) {
      if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue;
      const init = prop.initializer;
      if (init !== undefined && ts.isStringLiteral(init)) return init.text;
    }
    return null;
  };

  /** Does this element paint text or a glyph of its own, inheriting `color`? */
  const bearsOwnText = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean => {
    if (isGlyphElement(element)) return true;
    const tag = element.tagName.getText();
    if (!TEXT_BEARING_INTRINSICS.has(tag)) return false;
    if (tag !== "input") return true;
    const type = attrText(element, "type");
    return type === null || !NON_TEXT_INPUT_TYPES.has(type);
  };

  /** Renders characters of its own, as opposed to rendering only child elements. */
  const rendersText = (child: ts.JsxChild): boolean => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0;
    if (!ts.isJsxExpression(child) || child.expression === undefined) return false;
    // `{done && <Check />}` renders an element. `{count}` and `{ok ? <X/> : "Save"}`
    // render text — so look for a branch that is NOT JSX rather than for "contains JSX".
    const expr = child.expression;
    const branches: ts.Node[] = ts.isConditionalExpression(expr)
      ? [expr.whenTrue, expr.whenFalse]
      : ts.isBinaryExpression(expr) &&
          expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? [expr.right]
        : [expr];
    return branches.some(
      (b) =>
        !ts.isJsxElement(b) &&
        !ts.isJsxSelfClosingElement(b) &&
        !ts.isJsxFragment(b) &&
        b.kind !== ts.SyntaxKind.NullKeyword &&
        b.kind !== ts.SyntaxKind.FalseKeyword
    );
  };

  // Walk one feasible path of an accent-filled element's subtree. Text inherits the
  // nearest foreground an ancestor set, so carry it down; a descendant that provably
  // repaints its background is off the accent and ends this path.
  const walkSubtree = (
    children: readonly ts.JsxChild[],
    fillVariants: string[],
    inherited: Foreground | null
  ): void => {
    for (const child of children) {
      if (rendersText(child) && inherited === null) {
        report(
          child,
          "(inherited)",
          "renders text on an accent fill with no accent foreground — inherits body-text color"
        );
      }

      if (ts.isJsxFragment(child)) {
        walkSubtree(child.children, fillVariants, inherited);
        continue;
      }
      if (ts.isJsxExpression(child)) {
        if (child.expression === undefined) continue;
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
        continue;
      }
      if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) continue;

      const opening = ts.isJsxElement(child) ? child.openingElement : child;

      // Each of the descendant's own feasible paths is independent: a branch that shields
      // must not excuse a branch that does not.
      for (const set of setsOf(opening)) {
        if (shieldsBackground(set.utils, graph)) continue;

        const { offending, colorInState } = coexistingForegrounds(set.utils, fillVariants, graph);
        for (const fg of offending) {
          report(opening, fg.util.raw, "text painted on an ancestor's accent fill");
        }

        const here = colorInState ?? inherited;
        if (here === null && bearsOwnText(opening)) {
          report(
            opening,
            "(inherited)",
            "glyph on an accent fill with no accent foreground — inherits body-text color"
          );
        }
        if (ts.isJsxElement(child)) walkSubtree(child.children, fillVariants, here);
      }
    }
  };

  const checkElement = (element: ts.JsxElement | ts.JsxSelfClosingElement): void => {
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    for (const set of setsOf(opening)) {
      const fills = accentFills(set.utils, graph);
      if (fills.length === 0) continue;
      accentSurfaces++;

      for (const fill of fills) {
        const { offending, colorInState } = coexistingForegrounds(set.utils, fill.variants, graph);
        for (const fg of offending) {
          report(opening, fg.util.raw, "text painted on this element's accent fill");
        }
        if (colorInState === null && bearsOwnText(opening)) {
          report(
            opening,
            "(inherited)",
            "renders text on an accent fill with no accent foreground — inherits body-text color"
          );
        }
        if (ts.isJsxElement(element)) walkSubtree(element.children, fill.variants, colorInState);
      }
    }
  };

  // cva: the base classes apply to EVERY rendered variant, and one value is selected per
  // variant KEY — so a fill in `variant` and a foreground in `size` do co-occur. Build the
  // real products rather than pairing the base with one literal at a time.
  const checkCva = (call: ts.CallExpression): void => {
    const [baseArg, config] = call.arguments;
    const baseSets = feasibleSets(baseArg, locals);

    const keyGroups: Array<Array<{ node: ts.Node; utils: Util[] }>> = [];
    const compounds: Array<{ node: ts.Node; utils: Util[] }> = [];

    if (config !== undefined && ts.isObjectLiteralExpression(config)) {
      for (const prop of config.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

        if (prop.name.text === "variants" && ts.isObjectLiteralExpression(prop.initializer)) {
          for (const key of prop.initializer.properties) {
            if (!ts.isPropertyAssignment(key) || !ts.isObjectLiteralExpression(key.initializer)) {
              continue;
            }
            const options: Array<{ node: ts.Node; utils: Util[] }> = [];
            for (const option of key.initializer.properties) {
              if (!ts.isPropertyAssignment(option)) continue;
              const value = option.initializer;
              if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
                options.push({ node: value, utils: tokensOf(value.text) });
              }
            }
            // A key can also be omitted by the caller.
            if (options.length > 0) keyGroups.push([...options, { node: key, utils: [] }]);
          }
        }

        if (
          prop.name.text === "compoundVariants" &&
          ts.isArrayLiteralExpression(prop.initializer)
        ) {
          for (const entry of prop.initializer.elements) {
            if (!ts.isObjectLiteralExpression(entry)) continue;
            for (const field of entry.properties) {
              if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name)) continue;
              if (field.name.text !== "class" && field.name.text !== "className") continue;
              const value = field.initializer;
              if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
                compounds.push({ node: value, utils: tokensOf(value.text) });
              }
            }
          }
        }
      }
    }

    // One value per variant key, every combination — plus each compound class on its own.
    let combos: Array<{ nodes: ts.Node[]; utils: Util[] }> = baseSets.map((s) => ({
      nodes: [call],
      utils: s.utils,
    }));
    for (const group of keyGroups) {
      const next: Array<{ nodes: ts.Node[]; utils: Util[] }> = [];
      for (const combo of combos) {
        for (const option of group) {
          next.push({
            nodes: [...combo.nodes, option.node],
            utils: [...combo.utils, ...option.utils],
          });
        }
      }
      if (next.length > MAX_FEASIBLE_SETS) {
        throw new Error("accent-foreground guard: cva has too many variant combinations");
      }
      combos = next;
    }
    for (const compound of compounds) {
      combos = [
        ...combos,
        ...baseSets.map((s) => ({
          nodes: [compound.node],
          utils: [...s.utils, ...compound.utils],
        })),
      ];
    }

    for (const combo of combos) {
      const fills = accentFills(combo.utils, graph);
      if (fills.length === 0) continue;
      accentSurfaces++;
      const anchor = combo.nodes[combo.nodes.length - 1] ?? call;
      for (const fill of fills) {
        const { offending, colorInState } = coexistingForegrounds(
          combo.utils,
          fill.variants,
          graph
        );
        for (const fg of offending) {
          report(anchor, fg.util.raw, "text painted on an accent fill in a class-variant string");
        }
        if (colorInState === null) {
          report(
            anchor,
            "(inherited)",
            "accent-filled variant sets no accent foreground — text inherits body-text color"
          );
        }
      }
    }
  };

  // A whole-file literal sweep, as a fallback. Structural analysis cannot follow a class
  // string into an expression it cannot resolve, but a fill and a bad foreground sharing
  // ONE string are a bug wherever that string is written. Stay quiet about anything the
  // structural pass already reported — that has the better source location.
  const sweepLiterals = (): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const utils = tokensOf(node.text);
        for (const fill of accentFills(utils, graph)) {
          for (const fg of coexistingForegrounds(utils, fill.variants, graph).offending) {
            if (reportedUtilities.has(fg.util.raw)) continue;
            report(node, fg.util.raw, "text painted on an accent fill in the same class string");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) checkElement(node);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "cva"
    ) {
      checkCva(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  sweepLiterals();

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

  it("treats only genuinely opaque tokens as able to hide an accent fill", () => {
    expect(graph.isOpaqueToken("--theme-surface-panel")).toBe(true);
    // A wash: its theme value is an rgba(), so painting it over accent still shows accent.
    expect(graph.isOpaqueToken("--theme-overlay-soft")).toBe(false);
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
    expect(parseUtil("bg-[url(a/b.png)]")).toMatchObject({
      base: "bg-[url(a/b.png)]",
      opacity: null,
    });
    expect(parseUtil("w-[calc(1/2)]")).toMatchObject({ base: "w-[calc(1/2)]", opacity: null });
  });

  it("treats a fully-opaque modifier as no modifier at all", () => {
    expect(parseUtil("bg-primary/100").opacity).toBeNull();
    expect(parseUtil("text-primary-foreground/[1]").opacity).toBeNull();
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
    expect(parseUtil("group-hover/icon:text-white")).toMatchObject({
      variants: ["group-hover/icon"],
      base: "text-white",
      opacity: null,
    });
  });

  it("strips the important modifier in both spellings, including after a variant", () => {
    expect(parseUtil("bg-primary!").base).toBe("bg-primary");
    expect(parseUtil("!bg-primary").base).toBe("bg-primary");
    expect(parseUtil("hover:!bg-primary")).toMatchObject({
      variants: ["hover"],
      base: "bg-primary",
    });
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
    expect(
      analyze(`const x = <button className={cn("text-text-inverse", active && "bg-primary")} />;`)
    ).toEqual(["text-text-inverse"]);
  });

  it("flags an accent class string reached through a local constant", () => {
    expect(
      analyze(`
        const accentButton = "bg-primary text-white";
        const x = <button className={accentButton}>Save</button>;
      `)
    ).toEqual(["text-white"]);
  });

  it("flags a foreground that only lands on a base accent fill in a hover state", () => {
    // The fill is unconditional, so it is still there on hover — where the label turns white.
    expect(
      analyze(
        `const x = <button className="bg-primary text-primary-foreground hover:text-white">Go</button>;`
      )
    ).toEqual(["hover:text-white"]);
  });

  it("does not flag a checkbox — the UA draws its mark, which is not text", () => {
    expect(
      analyze(`const x = <input type="checkbox" className="checked:bg-daintree-accent" />;`)
    ).toEqual([]);
  });

  it("resolves each of color, fill and stroke independently", () => {
    // `fill-*` cannot override `color`; the white label stands.
    expect(
      analyze(`const x = <button className="bg-primary text-white fill-primary-foreground" />;`)
    ).toEqual(["text-white"]);
  });

  it("does not pair classes from opposite ternary branches", () => {
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

  it("does not pair branches of two ternaries on the same condition", () => {
    // `on` cannot be true and false at once — the accent fill never meets the neutral text.
    expect(
      analyze(`
        const x = (
          <button
            className={cn(
              on ? "bg-primary" : "bg-surface-panel",
              on ? "text-primary-foreground" : "text-daintree-text"
            )}
          >
            Save
          </button>
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

  it("flags text kept in the non-JSX branch of a conditional child", () => {
    expect(
      analyze(`
        const x = (
          <div className="bg-primary">
            {ok ? <Check className="text-primary-foreground" /> : "Save"}
          </div>
        );
      `)
    ).toEqual(["(inherited)"]);
  });

  it("flags an icon that inherits body-text color on an accent fill", () => {
    expect(
      analyze(`
        import { Check } from "lucide-react";
        const x = <div className="bg-daintree-accent"><Check /></div>;
      `)
    ).toEqual(["(inherited)"]);
  });

  it("does not treat an arbitrary child component as an icon", () => {
    // SomeChart paints itself; only known glyphs inherit currentColor.
    expect(analyze(`const x = <div className="bg-daintree-accent"><SomeChart /></div>;`)).toEqual(
      []
    );
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

  it("accepts a child glyph that supplies the validated foreground itself", () => {
    expect(
      analyze(`
        import { Check } from "lucide-react";
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
        `const x = <button className="text-daintree-text hover:bg-primary hover:text-primary-foreground">Go</button>;`
      )
    ).toEqual([]);
    // Same accent-on-hover, but the label is never repainted — the base text lands on it.
    expect(
      analyze(`const x = <button className="text-daintree-text hover:bg-primary">Go</button>;`)
    ).toEqual(["text-daintree-text"]);
  });

  it("ignores a pseudo-element's own fill and foreground", () => {
    expect(
      analyze(`const x = <div className="after:bg-daintree-accent text-daintree-text">Hi</div>;`)
    ).toEqual([]);
    expect(
      analyze(
        `const x = <div className="bg-primary text-primary-foreground before:text-white">Hi</div>;`
      )
    ).toEqual([]);
  });

  it("flags arbitrary and hardcoded colors that escape the validated token", () => {
    expect(
      analyze(`const x = <span className="bg-daintree-accent text-[var(--color-daintree-bg)]" />;`)
    ).toEqual(["text-[var(--color-daintree-bg)]"]);
    expect(analyze(`const x = <span className="bg-daintree-accent text-[#0b1220]" />;`)).toEqual([
      "text-[#0b1220]",
    ]);
    expect(analyze(`const x = <span className="bg-daintree-accent text-[red]" />;`)).toEqual([
      "text-[red]",
    ]);
    expect(analyze(`const x = <button className="bg-primary text-white" />;`)).toEqual([
      "text-white",
    ]);
  });

  it("flags an alpha-reduced copy of the validated foreground", () => {
    expect(
      analyze(`const x = <button className="bg-primary text-primary-foreground/50" />;`)
    ).toEqual(["text-primary-foreground/50"]);
    // …but a fully-opaque modifier is the validated token.
    expect(
      analyze(`const x = <button className="bg-primary text-primary-foreground/100" />;`)
    ).toEqual([]);
  });

  it("resolves an accent fill written in either arbitrary-value syntax", () => {
    expect(
      analyze(`const x = <button className="bg-[var(--color-accent-primary)] text-white" />;`)
    ).toEqual(["text-white"]);
    expect(analyze(`const x = <button className="bg-(--color-primary) text-white" />;`)).toEqual([
      "text-white",
    ]);
  });

  it("sees through an important modifier on the fill", () => {
    expect(
      analyze(`const x = <button className="hover:!bg-primary hover:text-white">Go</button>;`)
    ).toEqual(["hover:text-white"]);
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
    // `from-*` without a gradient image paints nothing.
    expect(analyze(`const x = <div className="from-primary text-white">Hi</div>;`)).toEqual([]);
  });

  it("stops descending only at a descendant that provably repaints its background", () => {
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
    // A translucent wash token does not shield: the accent still shows through.
    expect(
      analyze(`
        const x = (
          <div className="bg-primary">
            <span className="bg-overlay-soft text-text-inverse">still on accent</span>
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
    // A shielding branch must not excuse the branch that does not shield.
    expect(
      analyze(`
        const x = (
          <div className="bg-primary">
            <span className={ok ? "bg-surface-panel text-daintree-text" : "text-white"}>Save</span>
          </div>
        );
      `)
    ).toEqual(["text-white"]);
  });

  it("flags a cva base foreground against a fill introduced by a variant", () => {
    expect(
      analyze(
        `const v = cva("text-text-inverse", { variants: { tone: { accent: "bg-primary" } } });`
      )
    ).toEqual(["text-text-inverse"]);
  });

  it("flags a cva fill and foreground that meet across two variant keys", () => {
    // tone="accent" and size="sm" render together — the white label lands on the accent.
    expect(
      analyze(`
        const v = cva("text-primary-foreground", {
          variants: {
            tone: { accent: "bg-primary" },
            size: { sm: "text-white" },
          },
        });
      `)
    ).toEqual(["text-white"]);
  });

  it("does not flag a cva whose accent variants each carry the validated foreground", () => {
    expect(
      analyze(`
        const v = cva("inline-flex", {
          variants: {
            variant: {
              default: "bg-primary text-primary-foreground",
              ghost: "text-text-secondary hover:bg-overlay-soft",
            },
            size: { sm: "h-7 px-3 text-xs" },
          },
          defaultVariants: { variant: "default", size: "sm" },
        });
      `)
    ).toEqual([]);
  });
});

describe("accent foreground contract", () => {
  const filesByRoot = SCAN_ROOTS.map((root) => ({ root, files: collectSourceFiles(root) }));
  const files = filesByRoot.flatMap((r) => r.files);

  it("scans every root", () => {
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

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
// Everything below is derived from the graph, never from a hardcoded class name — so it
// accepts any spelling that resolves correctly (`text-primary-foreground`,
// `text-accent-primary-foreground`, a future alias), rejects any that does not, and
// stays honest if the token wiring is renamed.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");

const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "plugins/builtin/github/renderer"),
];

// The terminal tokens the contrast validator pairs. A utility is an "accent fill" iff it
// resolves here; a foreground is valid iff it resolves to the foreground counterpart.
const ACCENT_FILL_TOKEN = "--theme-accent-primary";
const ACCENT_FOREGROUND_TOKEN = "--theme-accent-foreground";

// Utility prefixes that paint a solid fill behind an element's own text.
const FILL_PREFIXES = ["bg-", "from-"];
// Utility prefixes that paint text/icon glyphs.
const FOREGROUND_PREFIXES = ["text-", "fill-", "stroke-"];

// ── CSS variable graph ─────────────────────────────────────────────────

/** Every `--name: value` in index.css, in document order — later wins, as the cascade does. */
function parseCssVariables(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    if (name === undefined || value === undefined) continue;
    declarations.set(name, value.trim());
  }
  return declarations;
}

/**
 * Follow a variable through pure `var(--x)` aliases to the name it ultimately points at.
 * Stops at the first variable whose value is not a bare alias (a literal color, a
 * color-mix, or undefined here because a theme supplies it at runtime) and returns that
 * variable's *name* — the semantic destination.
 */
function resolveToTerminalToken(name: string, declarations: Map<string, string>): string {
  const seen = new Set<string>();
  let current = name;
  while (!seen.has(current)) {
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
  /** Terminal token a `--color-*` utility name lands on, e.g. "primary" -> "--theme-accent-primary". */
  terminalOf: (utilityName: string) => string | null;
};

function buildColorGraph(css: string): ColorGraph {
  const declarations = parseCssVariables(css);
  const cache = new Map<string, string | null>();
  return {
    terminalOf(utilityName) {
      const cached = cache.get(utilityName);
      if (cached !== undefined) return cached;
      const varName = `--color-${utilityName}`;
      const terminal = declarations.has(varName)
        ? resolveToTerminalToken(varName, declarations)
        : null;
      cache.set(utilityName, terminal);
      return terminal;
    },
  };
}

// ── Utility classification ─────────────────────────────────────────────

/** Strip variant prefixes (`hover:`, `data-[state=on]:`, …), keeping the base utility. */
function stripVariants(utility: string): { base: string; variants: string[] } {
  const variants: string[] = [];
  let rest = utility;
  // Split on ":" that is not inside [...] — data-[state=checked]:bg-x has a ":" free colon only at the end.
  for (;;) {
    let depth = 0;
    let cut = -1;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      else if (ch === ":" && depth === 0) {
        cut = i;
        break;
      }
    }
    if (cut === -1) break;
    variants.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
  return { base: rest, variants };
}

/** `bg-daintree-accent/10` -> { name: "bg-daintree-accent", hasOpacity: true } */
function splitOpacity(base: string): { name: string; hasOpacity: boolean } {
  const slash = base.lastIndexOf("/");
  // Ignore a "/" inside an arbitrary value: text-[var(--x)]/50 is rare; bracket-aware enough.
  if (slash === -1 || base.indexOf("]") > slash) return { name: base, hasOpacity: false };
  return { name: base.slice(0, slash), hasOpacity: true };
}

/** A pseudo-element variant paints a separate box — not the element's own text surface. */
function isPseudoElement(variants: string[]): boolean {
  return variants.some((v) => v === "before" || v === "after");
}

/**
 * Does this utility paint a SOLID accent fill behind its own text?
 * Opacity-modified fills (`bg-daintree-accent/10`) are washes over the surface, not solid
 * accent, and `accent-soft`/`accent-muted` resolve to different terminal tokens — both
 * fall out naturally, the first by the opacity check, the second by the graph.
 */
function isSolidAccentFill(utility: string, graph: ColorGraph): boolean {
  const { base, variants } = stripVariants(utility);
  if (isPseudoElement(variants)) return false;
  const { name, hasOpacity } = splitOpacity(base);
  if (hasOpacity) return false;
  const prefix = FILL_PREFIXES.find((p) => name.startsWith(p));
  if (prefix === undefined) return false;
  return graph.terminalOf(name.slice(prefix.length)) === ACCENT_FILL_TOKEN;
}

/** Any background paint at all — a descendant carrying one re-paints, so its text is not on the accent. */
function isAnyBackground(utility: string): boolean {
  const { base, variants } = stripVariants(utility);
  if (isPseudoElement(variants)) return false;
  const { name } = splitOpacity(base);
  return name.startsWith("bg-") && name !== "bg-transparent" && !name.startsWith("bg-gradient-");
}

type Foreground = { utility: string; terminal: string | null };

/**
 * Classify a utility as a text/icon color, if it is one. Returns null for non-color `text-*`
 * utilities (text-xs, text-center, text-[9px]) so sizing/alignment never trips the guard.
 */
function asForeground(utility: string, graph: ColorGraph): Foreground | null {
  const { base } = stripVariants(utility);
  const { name } = splitOpacity(base);
  const prefix = FOREGROUND_PREFIXES.find((p) => name.startsWith(p));
  if (prefix === undefined) return null;
  const value = name.slice(prefix.length);

  // Arbitrary value: text-[var(--color-daintree-bg)] / text-[#0b1220] / text-[9px]
  const arbitrary = /^\[(.+)]$/.exec(value);
  if (arbitrary?.[1] !== undefined) {
    const inner = arbitrary[1];
    const varRef = /^var\(\s*--color-([\w-]+)\s*\)$/.exec(inner);
    if (varRef?.[1] !== undefined) {
      return { utility, terminal: graph.terminalOf(varRef[1]) };
    }
    // A literal color escapes the token system entirely; anything else (a length,
    // a font-size) is not a color at all.
    if (/^#[0-9a-f]{3,8}$/i.test(inner) || /^(rgb|hsl|oklch|color)\(/i.test(inner)) {
      return { utility, terminal: null };
    }
    return null;
  }

  // Hardcoded palette colors bypass theming outright.
  if (value === "white" || value === "black") return { utility, terminal: null };

  const terminal = graph.terminalOf(value);
  // Not a known color token => a sizing/alignment/decoration utility. Ignore.
  if (terminal === null) return null;
  return { utility, terminal };
}

function isValidAccentForeground(fg: Foreground): boolean {
  return fg.terminal === ACCENT_FOREGROUND_TOKEN;
}

// ── Source analysis ────────────────────────────────────────────────────

export type Violation = { file: string; line: number; utility: string; context: string };

function utilitiesOf(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

// Every node kind that can carry class text. Typed as the union rather than ts.Node so
// `.text` reads without a cast (the no-unsafe-type-assertion lint ratchet is per-rule).
type ClassLiteral =
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.TemplateHead
  | ts.TemplateMiddle
  | ts.TemplateTail;

/** Every class-ish string literal inside a node (covers cn(), cva variants, template chunks). */
function literalsIn(node: ts.Node): ClassLiteral[] {
  const out: ClassLiteral[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function classNameAttrOf(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): ts.JsxAttribute | null {
  for (const prop of element.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === "className") return prop;
  }
  return null;
}

/**
 * Utilities on an element's className. Conditional branches are merged deliberately: an
 * element that is accent-filled only when selected still has to be legible when selected.
 */
function elementUtilities(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  source: ts.SourceFile
): { utilities: string[]; line: number } {
  const attr = classNameAttrOf(element);
  const line = source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1;
  if (attr?.initializer === undefined) return { utilities: [], line };
  const utilities = literalsIn(attr.initializer).flatMap((lit) => utilitiesOf(lit.text));
  return { utilities, line };
}

function analyzeSource(fileName: string, sourceText: string, graph: ColorGraph): Violation[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  const violations: Violation[] = [];
  const lineOf = (n: ts.Node): number =>
    source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;

  const report = (node: ts.Node, fg: Foreground, context: string): void => {
    violations.push({ file: fileName, line: lineOf(node), utility: fg.utility, context });
  };

  // Rule A — a single class string that both fills with accent and paints its own text.
  // Catches cva variant strings and plain className literals.
  for (const literal of literalsIn(source)) {
    const utilities = utilitiesOf(literal.text);
    if (!utilities.some((u) => isSolidAccentFill(u, graph))) continue;
    for (const utility of utilities) {
      const fg = asForeground(utility, graph);
      if (fg !== null && !isValidAccentForeground(fg)) {
        report(literal, fg, "text painted on an accent fill in the same class string");
      }
    }
  }

  // Rule B — an accent-filled JSX element whose descendants paint the text (the badge/icon
  // shape: fill on the <div>, color on the child <Check>). Rule A cannot see across
  // elements, and every check-badge offender in #11115 had exactly this shape.
  const checkSubtree = (element: ts.JsxElement): void => {
    const { utilities } = elementUtilities(element.openingElement, source);
    if (!utilities.some((u) => isSolidAccentFill(u, graph))) return;

    const descend = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const own = elementUtilities(opening, source).utilities;
        // A descendant that paints its own background is no longer on the accent.
        if (own.some(isAnyBackground)) return;
        for (const utility of own) {
          const fg = asForeground(utility, graph);
          if (fg !== null && !isValidAccentForeground(fg)) {
            report(opening, fg, "text painted on an ancestor's accent fill");
          }
        }
      }
      ts.forEachChild(node, descend);
    };
    for (const child of element.children) descend(child);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) checkSubtree(node);
    ts.forEachChild(node, visit);
  };
  visit(source);

  return violations;
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

describe("accent foreground graph", () => {
  // If the wiring is renamed and these resolve nowhere, every scan below would pass
  // vacuously. Pin the two ends of the graph the whole guard is built on.
  it("resolves the shadcn and daintree fill aliases to one accent token", () => {
    expect(graph.terminalOf("primary")).toBe(ACCENT_FILL_TOKEN);
    expect(graph.terminalOf("daintree-accent")).toBe(ACCENT_FILL_TOKEN);
    expect(graph.terminalOf("accent-primary")).toBe(ACCENT_FILL_TOKEN);
  });

  it("resolves every accent foreground alias to the contrast-validated token", () => {
    expect(graph.terminalOf("primary-foreground")).toBe(ACCENT_FOREGROUND_TOKEN);
    expect(graph.terminalOf("accent-primary-foreground")).toBe(ACCENT_FOREGROUND_TOKEN);
    // Once shadowed by a duplicate shadcn declaration, which silently pointed it at body
    // text (#11115). It must land on the validated token or not exist at all.
    const accentForeground = graph.terminalOf("accent-foreground");
    if (accentForeground !== null) expect(accentForeground).toBe(ACCENT_FOREGROUND_TOKEN);
  });

  it("does not resolve the unvalidated foregrounds to the accent token", () => {
    expect(graph.terminalOf("text-inverse")).not.toBe(ACCENT_FOREGROUND_TOKEN);
    expect(graph.terminalOf("daintree-bg")).not.toBe(ACCENT_FOREGROUND_TOKEN);
  });
});

describe("accent foreground detector", () => {
  const analyze = (src: string): Violation[] => analyzeSource("fixture.tsx", src, graph);

  it("flags an unvalidated foreground in the same class string as an accent fill", () => {
    const found = analyze(`const x = <button className="bg-daintree-accent text-text-inverse" />;`);
    expect(found.map((v) => v.utility)).toEqual(["text-text-inverse"]);
  });

  it("flags a cva variant independently of its siblings", () => {
    const found = analyze(`
      const v = cva("base", {
        variants: {
          variant: {
            default: "bg-primary text-text-inverse",
            contrast: "bg-daintree-text text-text-inverse",
            ghost: "text-text-secondary hover:bg-overlay-soft",
          },
        },
      });
    `);
    // Only the accent-filled variant is a violation; the inverse-CTA and ghost variants
    // are not accent fills at all.
    expect(found).toHaveLength(1);
    expect(found[0]?.utility).toBe("text-text-inverse");
  });

  it("flags a child icon painted on an ancestor's accent fill", () => {
    const found = analyze(`
      const x = (
        <div className="rounded-full bg-daintree-accent">
          <Check className="h-2.5 w-2.5 text-daintree-bg" />
        </div>
      );
    `);
    expect(found.map((v) => v.utility)).toEqual(["text-daintree-bg"]);
  });

  it("flags a child icon reached through a conditional expression", () => {
    const found = analyze(`
      const x = (
        <span className={cn("border", isSelected ? "bg-daintree-accent" : "border-daintree-border")}>
          {isSelected && <Check className="w-3 h-3 text-text-inverse" />}
        </span>
      );
    `);
    expect(found.map((v) => v.utility)).toEqual(["text-text-inverse"]);
  });

  it("flags an arbitrary-value foreground that escapes the validated token", () => {
    const found = analyze(
      `const x = <span className="bg-daintree-accent text-[var(--color-daintree-bg)]" />;`
    );
    expect(found.map((v) => v.utility)).toEqual(["text-[var(--color-daintree-bg)]"]);
  });

  it("flags hardcoded palette colors on an accent fill", () => {
    const found = analyze(`const x = <button className="bg-primary text-white" />;`);
    expect(found.map((v) => v.utility)).toEqual(["text-white"]);
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
    const found = analyze(
      `const x = <button className="bg-primary text-accent-primary-foreground text-sm text-center text-[9px]" />;`
    );
    expect(found).toEqual([]);
  });

  it("ignores tinted accent washes — the text sits on the surface, not on solid accent", () => {
    expect(
      analyze(`const x = <div className="bg-daintree-accent/10 text-daintree-text" />;`)
    ).toEqual([]);
    expect(analyze(`const x = <div className="bg-accent-soft text-daintree-text" />;`)).toEqual([]);
  });

  it("ignores a pseudo-element accent fill — it paints a separate box, not the text surface", () => {
    expect(
      analyze(`const x = <div className="after:bg-daintree-accent text-daintree-text" />;`)
    ).toEqual([]);
  });

  it("stops descending at a child that repaints its own background", () => {
    const found = analyze(`
      const x = (
        <div className="bg-daintree-accent">
          <div className="bg-surface-panel">
            <span className="text-daintree-text">safe — on the panel, not the accent</span>
          </div>
        </div>
      );
    `);
    expect(found).toEqual([]);
  });

  it("flags a gradient accent fill", () => {
    const found = analyze(
      `const x = <button className="bg-gradient-to-b from-primary to-primary/80 text-text-inverse" />;`
    );
    expect(found.map((v) => v.utility)).toEqual(["text-text-inverse"]);
  });
});

describe("accent foreground contract", () => {
  const files = SCAN_ROOTS.flatMap(collectSourceFiles);

  it("scans a non-trivial number of components", () => {
    // Guards the whole suite against passing because the walker silently found nothing.
    expect(files.length).toBeGreaterThan(100);
  });

  it("paints text on a solid accent fill only with the contrast-validated foreground", () => {
    const violations = files.flatMap((file) =>
      analyzeSource(path.relative(REPO_ROOT, file), fs.readFileSync(file, "utf-8"), graph)
    );

    const report = violations.map((v) => `${v.file}:${v.line} — ${v.utility} (${v.context})`);
    expect(
      report,
      "Text on a solid accent fill must use a foreground that resolves to " +
        `${ACCENT_FOREGROUND_TOKEN} (e.g. text-primary-foreground on bg-primary, ` +
        "text-accent-primary-foreground on bg-daintree-accent). Tokens like text-text-inverse " +
        "and text-daintree-bg are keyed to the theme's body-text polarity, not to the accent, " +
        "so the contrast validator never checks them against the accent fill (#11115)."
    ).toEqual([]);
  });
});

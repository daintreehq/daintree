import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import { contrastRatio, resolvePaletteRowBackdrops } from "@shared/theme/contrast";
import { readIndexCss } from "@/__tests__/support/hostCss";
import { LIST_DETAIL_ROW_CLASS, PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";

/**
 * The highlighted-row language (docs/themes/interaction-state-recipes.md,
 * "Highlighted Row"): one row is lit, by a fill, and the pointer and the arrow
 * keys move that same row. Ways to break it that no single component test
 * sees — a cursor list that paints its own hover fill beside the cursor, a
 * leading rail creeping back onto a highlighted row, and a row whose fill the
 * increased-contrast and forced-colours outlines cannot find — are scanned for
 * across the renderer and the builtin plugin renderers.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const ROOTS = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "plugins/builtin")];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The argument text of every `cn(...)` call that composes `PALETTE_ROW_CLASS`. */
function paletteRowCnCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("cn(", from);
    if (start === -1) break;
    let depth = 0;
    let end = start + 2;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Comments mention the class by name in rows that deliberately do not use it.
    const body = source
      .slice(start, end + 1)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    if (/\bPALETTE_ROW_CLASS\b/.test(body)) calls.push(body);
    from = start + 3;
  }
  return calls;
}

/**
 * List-detail browsers, where a click picks the record the detail pane shows.
 * There hover and selection really are two states, so a lighter hover step is
 * the design — see "List Row Hover" in the recipes.
 */
const LIST_DETAIL_FILES = new Set([
  "src/components/Plugin/PluginManagerView.tsx",
  "src/components/Plugin/ProjectPluginSection.tsx",
  "src/components/Diagnostics/TelemetryContent.tsx",
  "src/components/EventInspector/EventTimeline.tsx",
  "src/components/ThemeBrowser/ThemeBrowser.tsx",
]);

const files = ROOTS.flatMap(sourceFiles).map((file) => ({
  rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
  source: fs.readFileSync(file, "utf8"),
}));

describe("highlighted-row language", () => {
  it("never lets a cursor-driven palette row paint a hover fill of its own", () => {
    const offenders: string[] = [];
    for (const { rel, source } of files) {
      if (LIST_DETAIL_FILES.has(rel)) continue;
      for (const call of paletteRowCnCalls(source)) {
        const hoverFills = call.match(/hover:bg-[\w[\]/.-]+/g);
        if (hoverFills) offenders.push(`${rel}: ${hoverFills.join(", ")}`);
      }
    }
    expect(
      offenders,
      "A palette row's pointer moves the cursor (onPointerMove) instead of painting a second lit row"
    ).toEqual([]);
  });

  it("keeps the list-detail allowlist honest", () => {
    const stale = [...LIST_DETAIL_FILES].filter((rel) => {
      const file = files.find((f) => f.rel === rel);
      return !file || !paletteRowCnCalls(file.source).some((call) => /hover:bg-/.test(call));
    });
    expect(stale, "remove entries that no longer compose a hover step").toEqual([]);
  });

  it("draws no leading selection rail on any row", () => {
    const offenders = files
      .filter(({ source }) => /before:bg-selection-outline/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);

    const css = readIndexCss();
    expect(css).not.toMatch(/\.palette-row[^{]*::before/);
  });

  it("marks the settings page shown with a neutral fill that out-weighs its hover, on every theme", () => {
    // The nav is a list-detail list: the page shown takes the one highlight
    // mark, never an accent tint, and hover is a lighter step in the same
    // direction so pointing at another page can't read as the selection.
    const parse = (value: string) => {
      const rgba = value.match(
        /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/
      );
      if (rgba)
        return { rgb: [rgba[1], rgba[2], rgba[3]].map(Number), a: rgba[4] ? Number(rgba[4]) : 1 };
      const hex = value.match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        const n = parseInt(hex[1]!, 16);
        return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 };
      }
      return null;
    };
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const ext = (scheme.extensions ?? {}) as Record<string, string | undefined>;
      const active = parse(ext["settings-nav-active-bg"] ?? scheme.tokens["overlay-highlight"]);
      const hover = parse(ext["settings-nav-hover-bg"] ?? scheme.tokens["overlay-subtle"]);
      expect(active, `${scheme.id}: settings nav active fill must be readable`).not.toBeNull();
      expect(hover, `${scheme.id}: settings nav hover fill must be readable`).not.toBeNull();
      const spread = Math.max(...active!.rgb) - Math.min(...active!.rgb);
      expect(
        spread,
        `${scheme.id}: the page shown is marked neutrally, not tinted`
      ).toBeLessThanOrEqual(24);
      expect(
        hover!.a,
        `${scheme.id}: hover must be a lighter step than the page shown`
      ).toBeLessThan(active!.a === 1 && hover!.a < 1 ? 1 : active!.a);
    }
  });

  it("makes the highlight a heavier step than the list-detail hover on every built-in theme", () => {
    // Where hover and selection coexist, the two must never be mistaken for one
    // another, so the highlight has to be the stronger lift of the two.
    const alpha = (value: string): number | null => {
      const m = value.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
      return m ? Number(m[1]) : null;
    };
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const highlight = scheme.tokens["overlay-highlight"];
      const hover = scheme.tokens["overlay-subtle"];
      expect(highlight, `${scheme.id}: overlay-highlight`).toBeTruthy();
      expect(highlight, `${scheme.id}: highlight must differ from hover`).not.toBe(hover);
      const a = alpha(highlight);
      const b = alpha(hover);
      if (scheme.type === "dark" && a !== null && b !== null) {
        expect(a, `${scheme.id}: highlight alpha vs overlay-subtle`).toBeGreaterThan(b);
      }
    }
  });

  it("keeps primary and secondary text at 4.5:1 on the highlighted row in every built-in theme", () => {
    // The ceiling on the fill's strength (#15865). Text on a fill k:1 from its
    // surface measures contrast(text, surface) / k, so a neutral fill at 3:1
    // would take text-secondary to 2.0-3.2:1 in every theme. Whatever the fill
    // becomes, the row's own two text tiers stay readable on it.
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const rows = resolvePaletteRowBackdrops(scheme.tokens, scheme.type).filter((row) =>
        row.label.startsWith("the highlighted row")
      );
      expect(rows.length, `${scheme.id}: no evaluable highlighted row`).toBeGreaterThan(0);
      for (const ink of ["text-primary", "text-secondary"] as const) {
        for (const row of rows) {
          const ratio = contrastRatio(scheme.tokens[ink], row.hex);
          expect(
            ratio,
            `${scheme.id}: ${ink} on ${row.label} is ${ratio.toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("outlines every hook it accepts in both high-contrast modes", () => {
    const css = readIndexCss().replace(/\/\*[\s\S]*?\*\//g, "");
    for (const query of ["(prefers-contrast: more)", "(forced-colors: active)"]) {
      const selectors = outlinedSelectors(mediaBlocks(css, query));
      for (const hook of OUTLINE_HOOKS) {
        expect(
          selectors.some((selector) => selector.startsWith(hook)),
          `${query} outlines ${hook}`
        ).toBe(true);
      }
    }
    // The shared row classes count as a hook below only because they carry the
    // marker the two blocks select on.
    for (const shared of [PALETTE_ROW_CLASS, LIST_DETAIL_ROW_CLASS]) {
      expect(shared.split(/\s+/)).toContain("palette-row");
    }
  });

  it("puts an outline hook on every element that paints the highlight", () => {
    const offenders: string[] = [];
    const ownTreatment = new Map<string, number>();
    for (const { rel, source } of files) {
      if (rel === "src/components/ui/paletteRowStyles.ts") continue;
      for (const paint of highlightPaints(source, rel)) {
        if (paint.hooked) continue;
        const own = OWN_TREATMENT[rel];
        if (own && paint.classes.some((token) => own.treatment.test(token))) {
          ownTreatment.set(rel, (ownTreatment.get(rel) ?? 0) + 1);
          continue;
        }
        offenders.push(`${rel}:${paint.line} ${paint.reason}`);
      }
    }
    expect(
      offenders,
      "A highlighted row's fill is the quietest mark there is; increased contrast and forced colours outline it through `palette-row` (+ aria-selected / data-selected), `forge-row` (+ data-active) or a Radix item's data-highlighted"
    ).toEqual([]);
    expect(
      Object.fromEntries(ownTreatment),
      "keep OWN_TREATMENT to the sites that need it"
    ).toEqual(
      Object.fromEntries(Object.entries(OWN_TREATMENT).map(([rel, own]) => [rel, own.paints]))
    );
  });

  it("reads a highlight paint the way the outline rules match it", () => {
    const reasons = (source: string) =>
      highlightPaints(source).map((paint) => (paint.hooked ? "hooked" : paint.reason));
    expect(
      reasons(`<div aria-selected={on} className={cn("px-2", on && "bg-overlay-highlight")} />`)
    ).toEqual(["no outline hook"]);
    expect(reasons(`<div aria-selected={on} className={cn(PALETTE_ROW_CLASS, "px-2")} />`)).toEqual(
      []
    );
    expect(
      reasons(
        `<div aria-selected={on} className={cn(/* palette-row */ "aria-selected:bg-overlay-highlight")} />`
      )
    ).toEqual(["no outline hook"]);
    expect(
      reasons(`<div className={cn("palette-row", "aria-selected:bg-overlay-highlight")} />`)
    ).toEqual(["`palette-row` without aria-selected or data-selected"]);
    expect(
      reasons(
        `<div data-active={a ? "true" : undefined} className={cn("forge-row", a && "bg-overlay-highlight")} />`
      )
    ).toEqual(["hooked"]);
    expect(reasons(`<div className={cn("forge-row", a && "bg-overlay-highlight")} />`)).toEqual([
      "`forge-row` without data-active",
    ]);
    expect(
      reasons(
        `<Item className="data-[highlighted]:bg-overlay-highlight hover:bg-overlay-highlight" />`
      )
    ).toEqual(["hooked"]);
    expect(
      reasons(
        `<b className={cn("data-[active]:bg-overlay-highlight", "contrast-more:data-[active]:outline-2", "forced-colors:data-[active]:outline-2")} />`
      )
    ).toEqual(["hooked"]);
    expect(reasons(`const ROW = "aria-selected:bg-overlay-highlight";`)).toEqual([
      "painted outside a className attribute",
    ]);
  });
});

/** The selectors the two high-contrast blocks outline a highlighted row by. */
const OUTLINE_HOOKS = [
  '.palette-row[aria-selected="true"]',
  '.palette-row[data-selected="true"]',
  '.forge-row[data-active="true"]',
  "[data-highlighted]",
];

/**
 * Rows that paint the highlight without a shared hook because they mark the
 * state some other way that already holds 3:1 by default. Each entry names the
 * class token that carries that mark, so a site that loses it fails here.
 */
const OWN_TREATMENT: Record<string, { paints: number; treatment: RegExp; why: string }> = {
  "src/components/Worktree/WorktreeOverviewRow.tsx": {
    paints: 1,
    treatment: /:outline-accent-primary$/,
    why: "`aria-selected` is bulk membership there; the cursor is its own accent outline",
  },
  "src/components/Terminal/RecipeRunner/RecipeRunnerItem.tsx": {
    paints: 2,
    treatment: /aria-selected:border-\[var\(--color-selection-outline\)\]$/,
    why: "the cursor also draws a selection-outline border",
  },
  "src/components/Terminal/RecipeRunner/RecipeRunnerList.tsx": {
    paints: 1,
    treatment: /aria-selected:border-\[var\(--color-selection-outline\)\]$/,
    why: "the cursor also draws a selection-outline border",
  },
};

const HIGHLIGHT_PAINT = /^!?bg-overlay-highlight(\/\S+)?$/;

/** `a:[b:c]:d` → `["a", "[b:c]", "d"]`: variant colons only, not ones in brackets. */
function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

interface HighlightPaint {
  line: number;
  classes: string[];
  hooked: boolean;
  reason: string;
}

/**
 * Every class token that paints `overlay-highlight` as a row's state, read from
 * the syntax tree so a comment can neither hide a paint nor fake a hook. Hover
 * is supplemental and an open submenu trigger is not the row Enter acts on, so
 * neither counts as a paint here.
 */
function highlightPaints(source: string, fileName = "fixture.tsx"): HighlightPaint[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const out: HighlightPaint[] = [];
  const stateTokens = (text: string) =>
    text.split(/\s+/).filter((token) => {
      const parts = splitVariants(token);
      const variants = parts.slice(0, -1);
      return (
        HIGHLIGHT_PAINT.test(parts[parts.length - 1]!) &&
        !variants.includes("hover") &&
        !variants.includes("data-[state=open]")
      );
    });
  const isText = (n: ts.Node): n is ts.StringLiteralLike | ts.TemplateLiteralLikeNode =>
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n);
  const isClassName = (n: ts.Node): n is ts.JsxAttribute =>
    ts.isJsxAttribute(n) && n.name.getText(file) === "className";

  const visit = (node: ts.Node) => {
    if (isClassName(node) && node.initializer) {
      const classes: string[] = [];
      const names = new Set<string>();
      const collect = (n: ts.Node) => {
        if (ts.isIdentifier(n)) names.add(n.text);
        if (isText(n)) classes.push(...n.text.split(/\s+/).filter(Boolean));
        ts.forEachChild(n, collect);
      };
      collect(node.initializer);
      const paints = stateTokens(classes.join(" "));
      const shared = names.has("PALETTE_ROW_CLASS") || names.has("LIST_DETAIL_ROW_CLASS");
      if (paints.length > 0 || shared) {
        const attributes = new Set(
          node.parent.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => attribute.name.getText(file))
        );
        const variantsOf = (prefix: string) =>
          classes.some((token) => {
            const parts = splitVariants(token);
            return parts.slice(0, -1).includes(prefix) && /^outline/.test(parts[parts.length - 1]!);
          });
        const radixOnly = paints.every((token) =>
          splitVariants(token).includes("data-[highlighted]")
        );
        let hooked = false;
        let reason = "no outline hook";
        if (shared || radixOnly) hooked = true;
        else if (classes.includes("palette-row")) {
          hooked = attributes.has("aria-selected") || attributes.has("data-selected");
          reason = "`palette-row` without aria-selected or data-selected";
        } else if (classes.includes("forge-row")) {
          hooked = attributes.has("data-active");
          reason = "`forge-row` without data-active";
        } else if (variantsOf("contrast-more") && variantsOf("forced-colors")) hooked = true;
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        if (paints.length > 0) out.push({ line, classes, hooked, reason });
      }
      return;
    }
    if (isText(node) && stateTokens(node.text).length > 0) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      out.push({
        line,
        classes: [],
        hooked: false,
        reason: "painted outside a className attribute",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The bodies of every `@media <query>` block, braces matched. */
function mediaBlocks(css: string, query: string): string {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(`@media ${query}`, from);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}" && --depth === 0) break;
    }
    bodies.push(css.slice(open + 1, end));
    from = end;
  }
  return bodies.join("\n");
}

/** Each selector, whitespace removed, of every rule whose body sets an outline. */
function outlinedSelectors(css: string): string[] {
  const selectors: string[] = [];
  for (const [, list, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[;\s])outline(-color|-style)?\s*:/.test(body!)) continue;
    let depth = 0;
    let start = 0;
    const text = list!.replace(/\s+/g, "");
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === "," && depth === 0) || i === text.length) {
        selectors.push(text.slice(start, i));
        start = i + 1;
      }
    }
  }
  return selectors;
}

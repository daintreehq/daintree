import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import {
  blendOverBackground,
  contrastRatio,
  parseRgba,
  relativeLuminance,
  resolvePaletteRowBackdrops,
} from "@shared/theme/contrast";
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
      const backdrops = resolvePaletteRowBackdrops(scheme.tokens, scheme.type);
      const rows = backdrops.filter((row) => row.label.startsWith("the highlighted row"));
      expect(rows.length, `${scheme.id}: no evaluable highlighted row`).toBeGreaterThan(0);
      // One highlighted backdrop per resting surface, so this reads the fill.
      const resting = backdrops.filter((row) => !rows.includes(row));
      expect(rows.map((row) => row.label)).toEqual(
        resting.map((row) => `the highlighted row on ${row.label}`)
      );
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

  it("holds selection-outline at 3:1 on a highlighted row on either panel surface, in every built-in theme", () => {
    // List-detail rows, the file lists and the worktree overview sit on the
    // panel, not on the palette's floating surface, and take the same
    // increased-contrast outline. Dark panels are lighter than the sidebar the
    // palette is scored on, which closes the fill in on the outline (#16126).
    const over = (value: string, backdrop: string) => {
      const rgba = parseRgba(value);
      return rgba ? blendOverBackground(rgba.hex, backdrop, rgba.opacity) : value;
    };
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const panel of ["surface-panel", "surface-panel-elevated"] as const) {
        const surface = scheme.tokens[panel];
        const fill = over(scheme.tokens["overlay-highlight"], surface);
        const outline = over(scheme.tokens["selection-outline"], fill);
        for (const [label, against] of [
          ["the highlight fill", fill],
          [panel, surface],
        ] as const) {
          const ratio = contrastRatio(outline, against);
          expect(
            ratio,
            `${scheme.id}: selection-outline against ${label} on ${panel} is ${ratio.toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("darkens the sidebar by one perceptible, matching step on every light theme", () => {
    // The hosts section's current host and every list-detail selection drawn on
    // the sidebar (#16184). The fill is whatever `sidebar.css` paints there, on
    // the solid sidebar (reduced transparency, increased contrast, performance
    // mode) and on the chrome it normally is: the sidebar at 95% over the
    // canvas. An opaque plane tuned for white popovers landed on, or lighter
    // than, the tinted sidebars, so the row could not be picked out.
    const over = (value: string, backdrop: string) => {
      const rgba = parseRgba(value);
      return rgba ? blendOverBackground(rgba.hex, backdrop, rgba.opacity) : value;
    };
    const steps: Record<string, number[]> = { solid: [], chrome: [] };
    for (const scheme of BUILT_IN_APP_SCHEMES.filter((s) => s.type === "light")) {
      const t = scheme.tokens;
      const ext = (scheme.extensions ?? {}) as Record<string, string | undefined>;
      const fillToken = ext["sidebar-row-highlight-bg"] ?? t["overlay-highlight"];
      const backdrops = {
        solid: t["surface-sidebar"],
        chrome: blendOverBackground(t["surface-sidebar"], t["surface-canvas"], 0.95),
      };
      for (const [model, surface] of Object.entries(backdrops)) {
        const fill = over(fillToken, surface);
        const where = `${scheme.id}: the highlighted row on the ${model} sidebar`;
        expect(relativeLuminance(fill), `${where} is darker`).toBeLessThan(
          relativeLuminance(surface)
        );
        const step = contrastRatio(fill, surface);
        expect(step, `${where} steps ${step.toFixed(3)}:1`).toBeGreaterThanOrEqual(1.15);
        expect(step, `${where} steps ${step.toFixed(3)}:1`).toBeLessThanOrEqual(1.24);
        steps[model]!.push(step);
        const hover = over(t["overlay-subtle"], surface);
        expect(contrastRatio(hover, surface), `${where} out-weighs hover`).toBeLessThan(step);
        for (const ink of ["text-primary", "text-secondary"] as const) {
          const ratio = contrastRatio(t[ink], fill);
          expect(ratio, `${where}: ${ink} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
        const outline = over(t["selection-outline"], fill);
        for (const [label, against] of [
          ["the fill", fill],
          ["the sidebar", surface],
        ] as const) {
          const ratio = contrastRatio(outline, against);
          expect(
            ratio,
            `${where}: selection-outline against ${label} is ${ratio.toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
    for (const [model, values] of Object.entries(steps)) {
      const spread = Math.max(...values) - Math.min(...values);
      expect(
        spread,
        `the ${model} sidebar step varies ${spread.toFixed(3)} across light themes`
      ).toBeLessThanOrEqual(0.03);
    }
  });

  it("outlines every hook it accepts in both high-contrast modes", () => {
    const css = readIndexCss().replace(/\/\*[\s\S]*?\*\//g, "");
    // Chromium matches `prefers-contrast: more` under forced colours too, so the
    // theme-ink outline stands aside there and the system-colour one shows.
    const blocks = {
      "(prefers-contrast: more)": mediaBlocks(
        mediaBlocks(css, "(prefers-contrast: more)"),
        "(forced-colors: none)"
      ),
      "(forced-colors: active)": mediaBlocks(css, "(forced-colors: active)"),
    };
    for (const [query, block] of Object.entries(blocks)) {
      const selectors = outlinedSelectors(block);
      for (const hook of OUTLINE_HOOKS) {
        expect(
          selectors.some((selector) => matchesHook(selector, hook)),
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

  it("never lets the forced-colours idle-row rule hide a hooked row's outline", () => {
    // The rule that paints a Radix row's transparent outline `Canvas` outranks
    // the hook rules, so it has to exclude every state they outline.
    const block = mediaBlocks(
      readIndexCss().replace(/\/\*[\s\S]*?\*\//g, ""),
      "(forced-colors: active)"
    );
    const hiding = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /outline-color\s*:\s*(Canvas|transparent)\s*(;|$)/.test(body!))
      .map(([, list]) => list!.replace(/\s+/g, ""));
    expect(hiding.length).toBeGreaterThan(0);
    for (const selector of hiding) {
      expect(selector).toContain(":not([data-highlighted])");
      expect(selector).toContain(':not([data-state="open"])');
    }
  });

  it("keeps the overview cursor visible on a selected cell under increased contrast", () => {
    // Membership takes the cell's outline there, so the cursor is drawn inside it.
    const block = mediaBlocks(
      mediaBlocks(readIndexCss().replace(/\/\*[\s\S]*?\*\//g, ""), "(prefers-contrast: more)"),
      "(forced-colors: none)"
    );
    const ring = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, list]) =>
      list!
        .replace(/\s+/g, "")
        .endsWith('[data-overview-cursor="true"][aria-selected="true"]::after')
    );
    expect(ring, "a ring for the selected cursor cell").toBeDefined();
    expect(ring![2]).toMatch(/content\s*:\s*""/);
    expect(ring![2]).toMatch(/position\s*:\s*absolute/);
    expect(ring![2]).toMatch(/inset\s*:\s*[1-9]\d*px/);
    expect(ring![2]).toMatch(/border\s*:\s*2px solid var\(--color-accent-primary\)/);

    // The ring and the membership outline find the cell by these attributes.
    const row = files.find((f) => f.rel === "src/components/Worktree/WorktreeOverviewRow.tsx");
    const cells = elementsCarrying(row!.source, "data-worktree-overview-cell");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.get("role"), "the overview cell is a gridcell").toEqual(["gridcell"]);
    expect(cells[0]!.has("aria-selected"), "the overview cell carries aria-selected").toBe(true);
    // The selectors match the value "true", so the marker has to be able to say it.
    expect(cells[0]!.get("data-overview-cursor"), "the cursor cell says so").toContain("true");
  });

  it("accepts the recipe cursor only with its whole forced-colours outline", () => {
    const state = ["group-focus-within/recipes", "aria-selected"];
    const full = [
      "group-focus-within/recipes:aria-selected:bg-overlay-highlight",
      "group-focus-within/recipes:aria-selected:border-[var(--color-selection-outline)]",
      "forced-colors:group-focus-within/recipes:aria-selected:outline-solid",
      "forced-colors:group-focus-within/recipes:aria-selected:outline-2",
      "forced-colors:group-focus-within/recipes:aria-selected:outline-[color:Highlight]",
      "forced-colors:group-focus-within/recipes:aria-selected:-outline-offset-2",
    ];
    expect(recipeCursorTreatment(full, [state])).toBe(true);
    for (const missing of full.slice(1)) {
      expect(
        recipeCursorTreatment(
          full.filter((token) => token !== missing),
          [state]
        ),
        `without ${missing}`
      ).toBe(false);
      const offChain = missing.replace("group-focus-within/recipes:", "");
      expect(
        recipeCursorTreatment(
          full.map((token) => (token === missing ? offChain : token)),
          [state]
        ),
        `with ${offChain}`
      ).toBe(false);
    }
    for (const [from, to] of [
      ["outline-[color:Highlight]", "outline-[color:#fff]"],
      [":outline-2", ":outline-[3]"],
      [":-outline-offset-2", ":outline-offset-[-2]"],
    ]) {
      expect(
        recipeCursorTreatment(
          full.map((token) => token.replace(from!, to!)),
          [state]
        ),
        `with ${to}`
      ).toBe(false);
    }
    expect(
      recipeCursorTreatment(
        full.map((token) => token.replace(":-outline-offset-2", ":outline-offset-[-2px]")),
        [state]
      )
    ).toBe(true);
  });

  it("puts an outline hook on every element that paints the highlight", () => {
    const offenders: string[] = [];
    const ownTreatment = new Map<string, number>();
    for (const { rel, source } of files) {
      if (rel === "src/components/ui/paletteRowStyles.ts") continue;
      for (const paint of highlightPaints(source, rel)) {
        if (paint.hooked) continue;
        const own = OWN_TREATMENT[rel];
        if (paint.states.length > 0 && own?.treated(paint.classes, paint.states)) {
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
        `<div aria-selected={on} className={cn(PALETTE_ROW_CLASS, on && "bg-overlay-highlight")} />`
      )
    ).toEqual(["hooked"]);
    expect(
      reasons(`<div className={cn(LIST_DETAIL_ROW_CLASS, on && "bg-overlay-highlight")} />`)
    ).toEqual(["`palette-row` without aria-selected or data-selected"]);
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
      reasons(`<li role="option" className="data-[highlighted]:bg-overlay-highlight" />`)
    ).toEqual(["hooked"]);
    // The increased-contrast rule scopes [data-highlighted] to menu and option roles.
    expect(reasons(`<div className="data-[highlighted]:bg-overlay-highlight" />`)).toEqual([
      "no outline hook",
    ]);
    expect(
      reasons(
        `<Item className="data-[highlighted]:bg-overlay-highlight aria-selected:bg-overlay-highlight" />`
      )
    ).toEqual(["no outline hook"]);
    expect(
      reasons(
        `<b className={cn("data-[active]:bg-overlay-highlight", "contrast-more:data-[active]:outline-2", "forced-colors:data-[active]:outline-2")} />`
      )
    ).toEqual(["hooked"]);
    expect(
      reasons(
        `<b className={cn("data-[active]:bg-overlay-highlight", "contrast-more:data-[active]:outline-offset-2", "forced-colors:data-[active]:outline-offset-2")} />`
      )
    ).toEqual(["no outline hook"]);
    expect(
      reasons(
        `<b className={cn("data-[active]:bg-overlay-highlight", "contrast-more:data-[other]:outline-2", "forced-colors:data-[other]:outline-2")} />`
      )
    ).toEqual(["no outline hook"]);
    expect(reasons(`const ROW = "aria-selected:bg-overlay-highlight";`)).toEqual([
      "painted outside a className attribute",
    ]);
    // An open submenu's parent: outlined by its menuitem role and data-state.
    expect(
      reasons(
        `<SubTrigger className="data-[highlighted]:bg-overlay-highlight data-[state=open]:bg-overlay-highlight" />`
      )
    ).toEqual(["hooked"]);
    expect(
      reasons(`<div role="menuitem" className="data-[state=open]:bg-overlay-highlight" />`)
    ).toEqual(["hooked"]);
    expect(reasons(`<div className="data-[state=open]:bg-overlay-highlight" />`)).toEqual([
      "no outline hook",
    ]);
    // An explicit role outranks the tag, whichever way it is written.
    expect(
      reasons(`<SubTrigger role="button" className="data-[state=open]:bg-overlay-highlight" />`)
    ).toEqual(["no outline hook"]);
    expect(
      reasons(`<SubTrigger role={role} className="data-[state=open]:bg-overlay-highlight" />`)
    ).toEqual(["no outline hook"]);
    expect(
      reasons(`<Item role={"button"} className="data-[highlighted]:bg-overlay-highlight" />`)
    ).toEqual(["no outline hook"]);
    expect(
      reasons(`<div role={"menuitem"} className="data-[state=open]:bg-overlay-highlight" />`)
    ).toEqual(["hooked"]);
    expect(
      reasons(
        `<SubTrigger className="data-[state=open]:bg-overlay-highlight aria-selected:bg-overlay-highlight" />`
      )
    ).toEqual(["no outline hook"]);
    // The worktree overview's membership: its role, marker and own aria-selected.
    expect(
      reasons(
        `<div role="gridcell" aria-selected={on} data-worktree-overview-cell={id} className={cn("px-2", "aria-selected:bg-overlay-highlight")} />`
      )
    ).toEqual(["hooked"]);
    expect(
      reasons(
        `<div role="gridcell" data-worktree-overview-cell={id} className="aria-selected:bg-overlay-highlight" />`
      )
    ).toEqual(["an overview cell painted on something other than its own `aria-selected`"]);
    expect(
      reasons(
        `<div role="gridcell" aria-selected={on} data-worktree-overview-cell={id} className="data-[active]:bg-overlay-highlight" />`
      )
    ).toEqual(["an overview cell painted on something other than its own `aria-selected`"]);
    expect(
      reasons(
        `<div role="gridcell" aria-selected={on} className="aria-selected:bg-overlay-highlight" />`
      )
    ).toEqual(["no outline hook"]);
  });
});

/** The selectors the two high-contrast blocks outline a highlighted row by. */
const OUTLINE_HOOKS = [
  '.palette-row[aria-selected="true"]',
  '.palette-row[data-selected="true"]',
  '.forge-row[data-active="true"]',
  "[data-highlighted]",
  // A submenu's parent row keeps the fill while focus is inside the submenu.
  '[role="menuitem"][data-state="open"]',
  // The worktree overview's bulk membership; its cursor is its own outline.
  '[role="gridcell"][aria-selected="true"][data-worktree-overview-cell]',
];

/**
 * Rows that paint the highlight without a shared hook because they mark the
 * state some other way that already holds 3:1 by default. Each entry checks the
 * classes that carry that mark, so a site that loses it fails here.
 */
const OWN_TREATMENT: Record<
  string,
  { paints: number; treated: (classes: string[], states: string[][]) => boolean; why: string }
> = {
  "src/components/Terminal/RecipeRunner/RecipeRunnerItem.tsx": {
    paints: 2,
    treated: recipeCursorTreatment,
    why: "the cursor's card border steps to selection-outline, and forced colours outlines it",
  },
  "src/components/Terminal/RecipeRunner/RecipeRunnerList.tsx": {
    paints: 1,
    treated: recipeCursorTreatment,
    why: "the cursor's card border steps to selection-outline, and forced colours outlines it",
  },
};

/**
 * The recipe cursor is a bordered card, so its mark is the border stepping to
 * `selection-outline` in the same state. Forced colours repaints every button
 * border `ButtonText`, and in list mode focus stays in the filter field, so
 * there the cursor needs a `Highlight` outline under the same state too.
 */
function recipeCursorTreatment(classes: string[], states: string[][]): boolean {
  return states.every((state) => {
    const under = (chain: string[], test: (utility: string) => boolean) =>
      hasClass(classes, (variants, utility) => test(utility) && sameChain(variants, chain));
    const forced = ["forced-colors", ...state];
    return (
      under(state, (utility) => utility === "border-[var(--color-selection-outline)]") &&
      under(forced, (utility) => utility === "outline-solid") &&
      under(forced, (utility) => OUTLINE_WIDTH.test(utility)) &&
      under(forced, (utility) => utility === "outline-[color:Highlight]") &&
      under(forced, (utility) => INSET_OUTLINE_OFFSET.test(utility))
    );
  });
}

// An arbitrary length needs its unit: `outline-offset-[-2]` emits a value CSS drops.
const OUTLINE_WIDTH = /^outline-([1-9]\d*|\[(length:)?(\d*\.)?\d*[1-9]\d*[a-z]+\])$/;
const INSET_OUTLINE_OFFSET =
  /^(-outline-offset-[1-9]\d*|outline-offset-\[-(\d*\.)?\d*[1-9]\d*[a-z]+\])$/;

/** An outline utility that draws one: a width or a style, not an offset or a colour. */
const VISIBLE_OUTLINE =
  /^outline(-solid|-dashed|-dotted|-double|-[1-9]\d*|-\[(length:)?(\d*\.)?\d*[1-9]\d*[a-z]*\])?$/;

/** Radix's item primitives, which carry a menu or option role of their own. */
const RADIX_ITEM_TAGS = new Set(["Item", "CheckboxItem", "RadioItem", "SubTrigger"]);
const RADIX_ITEM_ROLES = new Set(["menuitem", "menuitemcheckbox", "menuitemradio", "option"]);

function sameChain(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((variant, i) => variant === b[i]);
}

function hasClass(
  classes: string[],
  test: (variants: string[], utility: string) => boolean
): boolean {
  return classes.some((token) => {
    const parts = splitVariants(token);
    return test(parts.slice(0, -1), parts[parts.length - 1]!);
  });
}

/** Exact, but for the Radix rule, which the increased-contrast block scopes by role. */
function matchesHook(selector: string, hook: string): boolean {
  if (selector === hook) return true;
  const roles = selector.match(/^\[data-highlighted\]:is\(([^()]*)\)$/)?.[1]?.split(",");
  return (
    hook === "[data-highlighted]" &&
    roles !== undefined &&
    roles.length === RADIX_ITEM_ROLES.size &&
    [...RADIX_ITEM_ROLES].every((role) => roles.includes(`[role="${role}"]`))
  );
}

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
  /** The variant chain of each paint token, `["aria-selected"]` and so on. */
  states: string[][];
  hooked: boolean;
  reason: string;
}

/**
 * Every class token that paints `overlay-highlight` as a row's state, read from
 * the syntax tree so a comment can neither hide a paint nor fake a hook. Hover
 * is supplemental, so it does not count as a paint here.
 */
function highlightPaints(source: string, fileName = "fixture.tsx"): HighlightPaint[] {
  // Parsing all ~3,000 files timed out under load (#16154). A paint the raw text
  // doesn't name has to be escape-spelled (`"bg\x2doverlay-highlight"`); catching
  // those means parsing every file with a backslash, a third of the old cost.
  if (!source.includes("bg-overlay-highlight")) return [];
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
      return HIGHLIGHT_PAINT.test(parts[parts.length - 1]!) && !variants.includes("hover");
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
      if (paints.length > 0) {
        const states = paints.map((token) => splitVariants(token).slice(0, -1));
        const attributes = new Map<string, ts.JsxAttribute>();
        for (const attribute of node.parent.properties) {
          if (ts.isJsxAttribute(attribute)) attributes.set(attribute.name.getText(file), attribute);
        }
        const element = node.parent.parent;
        const tag = element.tagName.getText(file);
        // An explicit role wins over the tag: Radix forwards it, and the outline
        // rules select by role. One this scan can't read hooks nothing.
        const roleAttribute = attributes.get("role");
        const role = roleAttribute && literalText(roleAttribute.initializer);
        const radixItem = roleAttribute
          ? role !== null && role !== undefined && RADIX_ITEM_ROLES.has(role)
          : RADIX_ITEM_TAGS.has(tag);
        // The paint's own state, outlined in each mode: a visible outline, not
        // just an offset, under the same variants the fill is painted under.
        const outlinedIn = (mode: string) =>
          states.every((state) =>
            hasClass(
              classes,
              (variants, utility) =>
                VISIBLE_OUTLINE.test(utility) && sameChain(variants, [mode, ...state])
            )
          );
        const shared = names.has("PALETTE_ROW_CLASS") || names.has("LIST_DETAIL_ROW_CLASS");
        let hooked = false;
        let reason = "no outline hook";
        const menuItem = roleAttribute ? role === "menuitem" : tag === "SubTrigger";
        // An open submenu's parent row is outlined by its role and `data-state`.
        const radixOnly = states.every(
          (state) =>
            state.includes("data-[highlighted]") ||
            (menuItem && state.includes("data-[state=open]"))
        );
        const overviewCell = role === "gridcell" && attributes.has("data-worktree-overview-cell");
        if (radixOnly && radixItem) hooked = true;
        else if (radixOnly) hooked = outlinedIn("contrast-more") && outlinedIn("forced-colors");
        else if (overviewCell) {
          hooked =
            attributes.has("aria-selected") &&
            states.every((state) => sameChain(state, ["aria-selected"]));
          reason = "an overview cell painted on something other than its own `aria-selected`";
        } else if (shared || classes.includes("palette-row")) {
          hooked = attributes.has("aria-selected") || attributes.has("data-selected");
          reason = "`palette-row` without aria-selected or data-selected";
        } else if (classes.includes("forge-row")) {
          hooked = attributes.has("data-active");
          reason = "`forge-row` without data-active";
        } else hooked = outlinedIn("contrast-more") && outlinedIn("forced-colors");
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        out.push({ line, classes, states, hooked, reason });
      }
      return;
    }
    if (isText(node) && stateTokens(node.text).length > 0) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      out.push({
        line,
        classes: [],
        states: [],
        hooked: false,
        reason: "painted outside a className attribute",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** A JSX attribute's value when it is a string literal, bare or in braces. */
function literalText(initializer: ts.JsxAttributeValue | undefined): string | null {
  if (initializer === undefined) return null;
  const value = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : null;
}

/**
 * Every JSX element in `source` that carries `marker`, as its attribute names
 * mapped to the string literals each attribute's value can produce.
 */
function elementsCarrying(source: string, marker: string): Map<string, string[]>[] {
  const file = ts.createSourceFile(
    "row.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const out: Map<string, string[]>[] = [];
  const literals = (node: ts.Node | undefined, into: string[] = []): string[] => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      into.push(node.text);
    }
    if (node) ts.forEachChild(node, (child) => void literals(child, into));
    return into;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = new Map(
        node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((attribute) => [attribute.name.getText(file), literals(attribute.initializer)])
      );
      if (attributes.has(marker)) out.push(attributes);
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

/** A rule body that draws a solid outline of some width, in a colour. */
function drawsOutline(body: string): boolean {
  const declared = (property: string) =>
    body.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  const width = /^(\d*\.)?\d*[1-9]\d*px$/;
  const shorthand = declared("outline")?.split(/\s+/);
  if (shorthand) {
    return (
      shorthand.includes("solid") &&
      shorthand.some((part) => width.test(part)) &&
      !shorthand.includes("transparent")
    );
  }
  const color = declared("outline-color");
  return (
    declared("outline-style") === "solid" &&
    width.test(declared("outline-width") ?? "") &&
    color !== undefined &&
    color !== "transparent"
  );
}

/** Each selector, whitespace removed, of every rule whose body draws an outline. */
function outlinedSelectors(css: string): string[] {
  const selectors: string[] = [];
  for (const [, list, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!drawsOutline(body!)) continue;
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

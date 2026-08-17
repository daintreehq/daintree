import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_THEME_TOKEN_KEYS, PANEL_KIND_BRAND_COLORS } from "@shared/theme";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const NON_COLOR_THEME_TOKENS = new Set([
  "shadow-ambient",
  "shadow-floating",
  "shadow-dialog",
  "material-blur",
  "material-saturation",
  "material-opacity",
  "radius-scale",
  "state-chip-bg-opacity",
  "state-chip-border-opacity",
  "label-pill-bg-opacity",
  "label-pill-border-opacity",
  "scrollbar-width",
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  "scrollbar-track",
  "panel-state-edge-width",
  "panel-state-edge-inset-block",
  "panel-state-edge-radius",
  "focus-ring-offset",
  "chrome-noise-texture",
  "scrim-blur",
  "scrim-blur-palette",
  "grain-opacity",
  "grain-blend",
]);

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        return [];
      }
      return collectSourceFiles(fullPath);
    }

    if (!/\.(ts|tsx|css)$/.test(entry.name)) {
      return [];
    }

    if (/\.(test|spec)\./.test(entry.name)) {
      return [];
    }

    return [fullPath];
  });
}

describe("color system contract", () => {
  const indexCss = fs.readFileSync(INDEX_CSS_PATH, "utf8");
  const exportedColorVars = new Set(
    Array.from(indexCss.matchAll(/--color-([a-z0-9-]+):/g), (match) => match[1]!)
  );

  it("exports every app theme token to the CSS layer", () => {
    for (const token of APP_THEME_TOKEN_KEYS.filter((key) => !NON_COLOR_THEME_TOKENS.has(key))) {
      expect(exportedColorVars.has(token), `Missing --color-${token} export`).toBe(true);
    }
  });

  it("uses only exported theme-style color utilities in renderer source", () => {
    const utilityRegex =
      /\b(?:bg|text|border|ring|outline|placeholder|fill|stroke)-((?:daintree|surface|text|accent|status|activity|category|pr|overlay|scrim|state|server|terminal|cat|filter)[a-z0-9-]*)(?:\/[^\s"'`)]+)?/g;

    const missing = new Map<string, string[]>();

    for (const filePath of collectSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(filePath, "utf8");
      const matches = new Set(Array.from(source.matchAll(utilityRegex), (match) => match[1]!));

      for (const token of matches) {
        if (exportedColorVars.has(token)) {
          continue;
        }

        const relativePath = path.relative(REPO_ROOT, filePath);
        const locations = missing.get(token) ?? [];
        locations.push(relativePath);
        missing.set(token, locations);
      }
    }

    expect(
      Object.fromEntries(
        Array.from(missing.entries()).map(([token, files]) => [token, Array.from(new Set(files))])
      )
    ).toEqual({});
  });

  it("keeps built-in panel kind colors theme-backed", () => {
    for (const [kind, color] of Object.entries(PANEL_KIND_BRAND_COLORS)) {
      expect(color, `${kind} panel color should resolve through theme variables`).toMatch(
        /^var\(--theme-/
      );
    }
  });

  it("exports --color-accent-primary-foreground mapped to --theme-accent-foreground", () => {
    expect(indexCss).toMatch(
      /--color-accent-primary-foreground:\s*var\(--theme-accent-foreground\)/
    );
  });

  it("defines --dock-shadow with alpha-pinned relative color (visible on light themes)", () => {
    // Regression for #8156: color-mix multiplied --theme-shadow-color's own
    // alpha (0.12 on light themes) toward transparent, making the dock shadow
    // effectively invisible. Relative color syntax strips the input alpha and
    // pins it at a visible value across all 14 themes.
    expect(indexCss).toMatch(
      /--dock-shadow:\s*0 -2px 12px rgb\(from var\(--theme-shadow-color\) r g b \/ 0\.35\)/
    );
    expect(indexCss).not.toMatch(/--dock-shadow:[^;]*color-mix/);
  });

  it("declares the waiting dock-item state tokens consumed by docked items", () => {
    // Regression for #8156: DockedTerminalItem/DockedTabGroup read these tokens
    // for the waiting-agent highlight, but they were never declared, so the
    // waiting state was visually identical to idle on every theme.
    expect(indexCss).toMatch(
      /--dock-item-bg-waiting:\s*color-mix\(in oklab, var\(--color-activity-waiting\) 10%, transparent\)/
    );
    expect(indexCss).toMatch(
      /--dock-item-border-waiting:\s*rgb\(from var\(--color-activity-waiting\) r g b \/ 0\.3\)/
    );
  });

  it("panel focus chrome consumes the extension vars WITH fallbacks (omission = legacy recipe)", () => {
    // The panel-focus-* / panel-selected-bg extension keys are only safe
    // because every consumer carries the pre-extension recipe as its var()
    // fallback — a theme that authors none of them must render identically.
    // Guard the fallback's presence (not its literal value) at each site.
    for (const selector of [
      ".terminal-selected",
      ".terminal-selected-quiet",
      ".assistant-focused",
      ".terminal-focused",
    ]) {
      const block = indexCss.match(
        new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{[^}]+\\}`)
      )?.[0];
      expect(block, `${selector} rule exists`).toBeTruthy();
      expect(block, `${selector} themeable border with fallback`).toMatch(
        /var\(\s*--panel-focus-border,\s*color-mix\(/
      );
      expect(block, `${selector} themeable shadow with fallback`).toMatch(
        /var\(\s*--panel-focus-shadow,\s*inset /
      );
    }
  });

  it("keeps the lone-pane quiet cue fill-free so it stays lighter than terminal-selected", () => {
    // #11837: the quiet cue exists precisely because the surface-lift fill is
    // what made an always-lit lone pane too heavy in #7544. If a later edit
    // gives it a background it stops being a distinct rung and the revert
    // that motivated this design gets re-litigated.
    const quiet = indexCss.match(/\.terminal-selected-quiet\s*\{[^}]+\}/)?.[0];
    expect(quiet, ".terminal-selected-quiet rule exists").toBeTruthy();
    expect(quiet).not.toMatch(/background/);
    // The full-strength sibling is the one that carries the fill — proves the
    // two rungs are actually different rather than both being fill-free.
    expect(indexCss.match(/\.terminal-selected\s*\{[^}]+\}/)?.[0]).toMatch(
      /background-color:\s*var\(\s*--panel-selected-bg/
    );
  });

  it("gives the lone-pane quiet cue the same accessibility parity as its siblings", () => {
    // A new focus class silently loses performance-mode / forced-colors /
    // increased-contrast handling unless it is added to all three blocks —
    // none of which fail loudly when a selector is missing.
    expect(indexCss).toMatch(/body\[data-performance-mode="true"\]\s+\.terminal-selected-quiet/);

    const forcedColors = indexCss.match(/@media \(forced-colors: active\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(forcedColors, "forced-colors block exists").toBeTruthy();
    expect(forcedColors).toMatch(/\.terminal-selected-quiet\s*\{[^}]*Highlight/);

    const increasedContrast = indexCss.match(
      /@media \(prefers-contrast: more\)\s*\{[\s\S]*?\n\}/
    )?.[0];
    expect(increasedContrast, "prefers-contrast block exists").toBeTruthy();
    expect(increasedContrast).toMatch(/\.terminal-selected-quiet/);
  });

  it("wires :root --background to --theme-surface-canvas", () => {
    expect(indexCss).toMatch(/--background:\s*var\(--theme-surface-canvas\)/);
  });

  it("wires :root --primary-foreground to --theme-accent-foreground", () => {
    expect(indexCss).toMatch(/--primary-foreground:\s*var\(--theme-accent-foreground\)/);
  });

  it(".dark block contains only --chart-* declarations", () => {
    const darkBlock = indexCss.match(/\.dark\s*\{[^}]+\}/s)?.[0] ?? "";
    const declarations = darkBlock.match(/--[\w-]+:/g) ?? [];
    for (const decl of declarations) {
      expect(decl, `Unexpected non-chart declaration in .dark: ${decl}`).toMatch(/^--chart-\d+:$/);
    }
    expect(declarations.length).toBe(5);
  });

  it("suppresses Tailwind default palette with --color-*: initial", () => {
    const themeBlock = indexCss.match(/@theme\s+inline\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(themeBlock).toMatch(/--color-\*:\s*initial/);
  });

  it("exports structural category color variants (-subtle, -text, -border)", () => {
    const categories = [
      "blue",
      "purple",
      "cyan",
      "green",
      "amber",
      "orange",
      "teal",
      "indigo",
      "rose",
      "pink",
      "violet",
      "slate",
    ];
    const variants = ["subtle", "text", "border"];
    for (const cat of categories) {
      for (const variant of variants) {
        expect(
          exportedColorVars.has(`category-${cat}-${variant}`),
          `Missing --color-category-${cat}-${variant}`
        ).toBe(true);
      }
    }
  });

  it("does not import github-dark.min.css", () => {
    expect(indexCss).not.toContain("github-dark.min.css");
  });

  it("contains no rgba(0,0,0) shadow values", () => {
    expect(indexCss).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });

  // A --color-* declared twice in one @theme inline block silently resolves to the
  // last one; Tailwind emits no warning. That is how --color-accent-foreground came
  // to resolve to body text instead of the contrast-validated accent foreground
  // (#11115), and how --color-accent-primary regressed before it (#2687). Uniqueness
  // is the invariant that catches the whole class.
  it("declares every --color-* exactly once across @theme inline", () => {
    // Count across EVERY @theme inline block, not just the first — a second block
    // would reintroduce cross-block shadowing that a single-block scan can't see.
    const blocks = [...indexCss.matchAll(/@theme\s+inline\s*\{[\s\S]*?\n\}/g)].map((m) => m[0]);
    expect(blocks.length, "could not locate any @theme inline block").toBeGreaterThan(0);

    const counts = new Map<string, number>();
    for (const block of blocks) {
      for (const [, name] of block.matchAll(/^\s*(--color-[\w-]+)\s*:/gm)) {
        if (name === undefined) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    expect(counts.size, "no --color-* declarations found — regex is stale").toBeGreaterThan(0);

    const duplicated = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} (x${count})`);
    expect(duplicated, "duplicate --color-* declarations silently shadow each other").toEqual([]);
  });

  it("sets color-scheme: normal on webview elements to prevent dark-mode inheritance", () => {
    expect(indexCss).toMatch(/webview\s*\{[^}]*color-scheme:\s*normal/s);
  });
});

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
    Array.from(indexCss.matchAll(/--color-([a-z0-9-]+):/g), (match) => match[1])
  );

  it("exports every app theme token to the CSS layer", () => {
    for (const token of APP_THEME_TOKEN_KEYS.filter((key) => !NON_COLOR_THEME_TOKENS.has(key))) {
      expect(exportedColorVars.has(token), `Missing --color-${token} export`).toBe(true);
    }
  });

  it("uses only exported theme-style color utilities in renderer source", () => {
    const utilityRegex =
      /\b(?:bg|text|border|ring|outline|placeholder|fill|stroke)-((?:canopy|surface|text|accent|status|activity|category|github|overlay|scrim|state|server|terminal|cat)[a-z0-9-]*)(?:\/[^\s"'`)]+)?/g;

    const missing = new Map<string, string[]>();

    for (const filePath of collectSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(filePath, "utf8");
      const matches = new Set(Array.from(source.matchAll(utilityRegex), (match) => match[1]));

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

  it("--color-accent-foreground in @theme inline resolves through shadcn --accent-foreground (preserves hover behavior)", () => {
    const themeBlock = indexCss.match(/@theme\s+inline\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(themeBlock).toMatch(/--color-accent-foreground:\s*var\(--accent-foreground\)/);
  });

  it("sets color-scheme: normal on webview elements to prevent dark-mode inheritance", () => {
    expect(indexCss).toMatch(/webview\s*\{[^}]*color-scheme:\s*normal/s);
  });
});

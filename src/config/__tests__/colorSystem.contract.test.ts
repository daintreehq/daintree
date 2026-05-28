import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_THEME_TOKEN_KEYS,
  PANEL_KIND_BRAND_COLORS,
  THEME_EXTENSION_KEYS,
  THEME_EXTENSION_REGISTRY,
} from "@shared/theme";

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

const THEME_COMPONENT_CSS_FILES = [
  "src/styles/components/toolbar.css",
  "src/styles/components/sidebar.css",
  "src/styles/components/settings.css",
  "src/styles/components/pulse.css",
  "src/styles/components/panels.css",
].map((rel) => path.join(REPO_ROOT, rel));

// Vars consumed via var(--x, …) in the theme component stylesheets that are NOT
// theme-extension hooks: derived surface/shadow aliases, semantic-token aliases,
// pip/badge colors set on the element by component logic, and design tokens
// (radius/timing). They are excluded from extension-drift detection so a derived
// alias doesn't masquerade as an unregistered extension key. Keep this list in
// sync only when a genuinely new non-extension var is consumed in these files.
const NON_EXTENSION_COMPONENT_VARS = new Set([
  // Chrome / dialog / floating-surface aliases derived from semantic tokens
  "chrome-bg",
  "chrome-noise",
  "chrome-noise-texture",
  "chrome-shadow",
  "dialog-bg",
  "dialog-shadow",
  "floating-surface-bg",
  "floating-surface-shadow",
  "sidebar-ring",
  "toolbar-bg",
  "toolbar-noise",
  "toolbar-control-active-bg",
  "toolbar-control-armed-bg",
  "settings-meta-fg",
  "settings-meta-size",
  "settings-section-header-bg",
  "settings-section-header-bg-solid",
  "toolbar-project-chip-size",
  // Pip / badge colors set on the element by component logic, not theme overrides
  "overflow-badge-color",
  "problems-dot-color",
  // Design tokens (radius / timing), not color overrides
  "radius-lg",
  "duration-150",
  "ease-out-expo",
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

describe("theme extension contract", () => {
  const consumedInComponentCss = new Set<string>();
  for (const file of THEME_COMPONENT_CSS_FILES) {
    const css = fs.readFileSync(file, "utf8");
    for (const match of css.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
      consumedInComponentCss.add(match[1]!);
    }
  }

  const consumedAnywhere = new Set<string>();
  for (const filePath of collectSourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
      consumedAnywhere.add(match[1]!);
    }
  }

  it("registers every extension hook consumed in theme component stylesheets", () => {
    // Reverse drift: a new var(--foo, …) hook added to a theme stylesheet must be
    // registered (or explicitly classified as a non-extension alias above), so the
    // canonical key set stays exhaustive.
    const unregistered = Array.from(consumedInComponentCss).filter(
      (name) =>
        !name.startsWith("theme-") &&
        !name.startsWith("color-") &&
        !NON_EXTENSION_COMPONENT_VARS.has(name) &&
        !(name in THEME_EXTENSION_REGISTRY)
    );
    expect(
      unregistered,
      `extension hooks consumed in component CSS but missing from THEME_EXTENSION_REGISTRY: ${unregistered.join(", ")}`
    ).toEqual([]);
  });

  it("consumes every registered extension key somewhere in renderer source", () => {
    // Forward drift: a registry key that nothing consumes is dead governance — drop it
    // from the registry (and any theme that defines it) instead of carrying it.
    const unused = THEME_EXTENSION_KEYS.filter((key) => !consumedAnywhere.has(key));
    expect(
      unused,
      `registered extension keys that are no longer consumed in source: ${unused.join(", ")}`
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_THEME_TOKEN_KEYS,
  LEGACY_THEME_TOKEN_ALIASES,
  PANEL_KIND_BRAND_COLORS,
} from "@shared/theme";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");
const SRC_ROOT = path.join(REPO_ROOT, "src");

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
    for (const token of APP_THEME_TOKEN_KEYS) {
      expect(exportedColorVars.has(token), `Missing --color-${token} export`).toBe(true);
    }
  });

  it("exports every legacy theme alias to the CSS layer", () => {
    for (const alias of Object.keys(LEGACY_THEME_TOKEN_ALIASES)) {
      expect(exportedColorVars.has(alias), `Missing --color-${alias} export`).toBe(true);
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

  it("maps .dark --primary-foreground to --color-accent-primary-foreground, not --color-accent-foreground", () => {
    const darkBlock = indexCss.match(/\.dark\s*\{[^}]+\}/s)?.[0] ?? "";
    expect(darkBlock).toMatch(/--primary-foreground:\s*var\(--color-accent-primary-foreground\)/);
    expect(darkBlock).not.toMatch(/--primary-foreground:\s*var\(--color-accent-foreground\)/);
  });

  it("maps .dark --sidebar-primary-foreground to --color-accent-primary-foreground", () => {
    const darkBlock = indexCss.match(/\.dark\s*\{[^}]+\}/s)?.[0] ?? "";
    expect(darkBlock).toMatch(
      /--sidebar-primary-foreground:\s*var\(--color-accent-primary-foreground\)/
    );
  });

  it("--color-accent-foreground in @theme inline resolves through shadcn --accent-foreground (preserves hover behavior)", () => {
    const themeBlock = indexCss.match(/@theme\s+inline\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(themeBlock).toMatch(/--color-accent-foreground:\s*var\(--accent-foreground\)/);
  });
});

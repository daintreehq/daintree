import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { getThemeContrastWarnings } from "../contrast.js";
import { EXTENSION_KEY_REGISTRY, isExtensionKeyRequired } from "../extensionRegistry.js";
import { THEME_EXTENSION_REGISTRY } from "../extensions.js";
import { auditSurfaceRamp, auditAccentProminence, auditCrossThemeAccents } from "../oklch.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { APP_THEME_TOKEN_KEYS, EXTENSION_KEYS } from "../types.js";

describe("built-in themes", () => {
  it("every source compiles to a valid AppColorScheme", () => {
    expect(BUILT_IN_THEME_SOURCES.length).toBeGreaterThan(0);
    expect(BUILT_IN_APP_SCHEMES).toHaveLength(BUILT_IN_THEME_SOURCES.length);
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(scheme.id).toBeTruthy();
      expect(scheme.name).toBeTruthy();
      expect(["dark", "light"]).toContain(scheme.type);
      expect(scheme.builtin).toBe(true);
      expect(scheme.tokens).toBeDefined();
    }
  });

  it("all theme IDs are unique", () => {
    const ids = BUILT_IN_APP_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "scheme %s passes theme contrast checks",
    (_id, scheme) => {
      const warnings = getThemeContrastWarnings(scheme);
      expect(warnings, warnings.map((w) => w.message).join("; ")).toHaveLength(0);
    }
  );

  it("every compiled scheme has all required token keys", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const key of APP_THEME_TOKEN_KEYS) {
        expect(scheme.tokens[key], `${scheme.id} missing token: ${key}`).toBeTruthy();
      }
    }
  });

  it("source palette type matches declared type", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      expect(source.palette.type, `${source.id} palette.type mismatch`).toBe(source.type);
    }
  });

  it("every source has location and heroImage metadata", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      expect(source.location, `${source.id} missing location`).toBeTruthy();
      expect(source.heroImage, `${source.id} missing heroImage`).toBeTruthy();
    }
  });

  it("every source palette has all required surface, text, and status fields", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      const { surfaces, text, status, activity, syntax } = source.palette;
      expect(surfaces.grid, `${source.id} missing surfaces.grid`).toBeTruthy();
      expect(surfaces.sidebar, `${source.id} missing surfaces.sidebar`).toBeTruthy();
      expect(surfaces.canvas, `${source.id} missing surfaces.canvas`).toBeTruthy();
      expect(surfaces.panel, `${source.id} missing surfaces.panel`).toBeTruthy();
      expect(surfaces.elevated, `${source.id} missing surfaces.elevated`).toBeTruthy();
      expect(text.primary, `${source.id} missing text.primary`).toBeTruthy();
      expect(text.secondary, `${source.id} missing text.secondary`).toBeTruthy();
      expect(text.muted, `${source.id} missing text.muted`).toBeTruthy();
      expect(text.inverse, `${source.id} missing text.inverse`).toBeTruthy();
      expect(status.success, `${source.id} missing status.success`).toBeTruthy();
      expect(status.warning, `${source.id} missing status.warning`).toBeTruthy();
      expect(status.danger, `${source.id} missing status.danger`).toBeTruthy();
      expect(status.info, `${source.id} missing status.info`).toBeTruthy();
      expect(activity.active, `${source.id} missing activity.active`).toBeTruthy();
      expect(activity.idle, `${source.id} missing activity.idle`).toBeTruthy();
      expect(activity.working, `${source.id} missing activity.working`).toBeTruthy();
      expect(activity.waiting, `${source.id} missing activity.waiting`).toBeTruthy();
      for (const key of Object.keys(syntax) as (keyof typeof syntax)[]) {
        expect(syntax[key], `${source.id} missing syntax.${key}`).toBeTruthy();
      }
    }
  });

  it("every source has a material blur strategy", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      expect(
        source.palette.strategy?.materialBlur,
        `${source.id} missing materialBlur`
      ).toBeGreaterThan(0);
      expect(
        source.palette.strategy?.materialSaturation,
        `${source.id} missing materialSaturation`
      ).toBeGreaterThan(0);
    }
  });

  it("surface-disabled token derives as opaque color (not rgba)", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const surfaceDisabled = scheme.tokens["surface-disabled"];
      expect(surfaceDisabled, `${scheme.id} surface-disabled should exist`).toBeTruthy();
      expect(surfaceDisabled, `${scheme.id} surface-disabled should be opaque`).not.toMatch(
        /^rgba\(/
      );
      expect(
        surfaceDisabled,
        `${scheme.id} surface-disabled should not contain undefined`
      ).not.toContain("undefined");
    }
  });

  it("status-danger-surface token derives as transparent wash", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(
        scheme.tokens["status-danger-surface"],
        `${scheme.id} status-danger-surface should be transparent wash`
      ).toMatch(
        /rgba\(.*,\s*0\.\d+\)|color-mix\(in oklab,\s*var\(--theme-status-danger\)\s*\d+%,\s*transparent\)/
      );
    }
  });

  it("knob-base token is polarity-aware (dark vs light)", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const knobBase = scheme.tokens["knob-base"];
      expect(knobBase, `${scheme.id} knob-base should be oklch`).toMatch(/oklch\(/);
      if (scheme.type === "dark") {
        expect(knobBase, `${scheme.id} dark theme knob should be light`).toMatch(
          /oklch\([0-9]\.[8-9]/
        );
      } else {
        expect(knobBase, `${scheme.id} light theme knob should be dark`).toMatch(
          /oklch\([0-1]\.[0-2]/
        );
      }
    }
  });

  it("state-modified token derives from status-info base", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const modified = scheme.tokens["state-modified"];
      expect(modified, `${scheme.id} state-modified should derive from status-info`).toContain(
        "color-mix"
      );
    }
  });

  it("EXTENSION_KEY_REGISTRY covers every canonical extension key", () => {
    // Drift guard between EXTENSION_KEYS and EXTENSION_KEY_REGISTRY: any new
    // key must be added to both, and any removed key must be dropped from both.
    const registryKeys = Object.keys(EXTENSION_KEY_REGISTRY).sort();
    const canonicalKeys = [...EXTENSION_KEYS].sort();
    expect(registryKeys).toEqual(canonicalKeys);
  });

  it.each(BUILT_IN_THEME_SOURCES.map((s) => [s.id, s] as const))(
    "theme %s satisfies extension-tier governance",
    (_id, source) => {
      const polarity = source.type;
      const extensions = source.extensions ?? {};
      const failures: string[] = [];

      for (const key of EXTENSION_KEYS) {
        const meta = EXTENSION_KEY_REGISTRY[key];
        const value = extensions[key];
        const required = isExtensionKeyRequired(key, polarity);

        if (required && value === undefined) {
          failures.push(`${source.id} (${polarity}) missing required extension: ${key}`);
          continue;
        }

        if (!required && meta.forbidWhenNotRequired && value !== undefined) {
          failures.push(
            `${source.id} (${polarity}) must not set ${key}; the CSS fallback is correct ` +
              `for this polarity and an override here inverts the bug it patches.`
          );
          continue;
        }

        if (value === undefined) continue;

        const tint = meta.perceptibility?.expectedTint?.[polarity];
        if (tint && !tint.test(value)) {
          failures.push(
            `${source.id} ${key} value "${value}" does not match expected ${polarity} tint`
          );
        }

        const minAlpha = meta.perceptibility?.minAlpha?.[polarity];
        if (minAlpha !== undefined) {
          const alpha = parseAlpha(value);
          if (Number.isNaN(alpha) || alpha < minAlpha) {
            failures.push(
              `${source.id} ${key} alpha ${alpha} below ${minAlpha} threshold (value="${value}")`
            );
          }
        }

        const maxAlpha = meta.perceptibility?.maxAlpha?.[polarity];
        if (maxAlpha !== undefined) {
          const alpha = parseAlpha(value);
          if (!Number.isNaN(alpha) && alpha > maxAlpha) {
            failures.push(
              `${source.id} ${key} alpha ${alpha} above ${maxAlpha} ceiling (value="${value}")`
            );
          }
        }

        if (meta.formatGuard && !meta.formatGuard.test(value)) {
          failures.push(`${source.id} ${key} value "${value}" does not match required format`);
        }

        if (meta.formatGuard && meta.minFormatAlpha !== undefined) {
          const m = value.match(meta.formatGuard);
          const alpha = m?.[1] !== undefined ? Number(m[1]) : NaN;
          if (Number.isNaN(alpha) || alpha < meta.minFormatAlpha || alpha > 1) {
            failures.push(
              `${source.id} ${key} format alpha ${alpha} outside [${meta.minFormatAlpha}, 1] (value="${value}")`
            );
          }
        }
      }

      // Cross-key invariant: sidebar-active-bg must be stronger than sidebar-hover-bg
      // so the selected row is distinguishable from the hovered row.
      const hover = extensions["sidebar-hover-bg"];
      const active = extensions["sidebar-active-bg"];
      if (hover !== undefined && active !== undefined) {
        const hoverAlpha = parseAlpha(hover);
        const activeAlpha = parseAlpha(active);
        if (!(activeAlpha > hoverAlpha)) {
          failures.push(
            `${source.id} sidebar-active-bg (alpha ${activeAlpha}) must be stronger than ` +
              `sidebar-hover-bg (alpha ${hoverAlpha}); values "${active}" vs "${hover}"`
          );
        }
      }

      // Extra-key regression: no built-in source ships an unregistered extension
      // key. TypeScript enforces this at compile time, but a runtime check
      // catches `as unknown as` casts and ad-hoc fixture mutations.
      const extraKeys = Object.keys(extensions).filter(
        (k) => !(EXTENSION_KEYS as readonly string[]).includes(k)
      );
      if (extraKeys.length > 0) {
        failures.push(`${source.id} ships unregistered extension keys: ${extraKeys.join(", ")}`);
      }

      expect(failures, failures.join("\n")).toHaveLength(0);
    }
  );

  it("surface elevation ramp passes OKLCH audit", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      const result = auditSurfaceRamp(source.palette.surfaces, source.id);
      for (const warning of result.warnings) {
        console.warn(`[OKLCH ramp] ${warning}`);
      }
      expect(
        result.failures,
        `${source.id} ramp failures:\n${result.failures.join("\n")}`
      ).toHaveLength(0);
    }
  });

  it("accent prominence passes OKLCH audit", () => {
    for (const source of BUILT_IN_THEME_SOURCES) {
      const result = auditAccentProminence(source.palette, source.id);
      for (const warning of result.warnings) {
        console.warn(`[OKLCH accent] ${warning}`);
      }
      expect(
        result.failures,
        `${source.id} accent failures:\n${result.failures.join("\n")}`
      ).toHaveLength(0);
    }
  });

  it("cross-theme accent distance passes OKLCH audit", () => {
    const result = auditCrossThemeAccents(BUILT_IN_THEME_SOURCES);
    for (const warning of result.warnings) {
      console.warn(`[OKLCH cross-theme] ${warning}`);
    }
    expect(result.failures, `cross-theme failures:\n${result.failures.join("\n")}`).toHaveLength(0);
  });

  it("EXTENSION_KEYS is in sync with the CSS/TSX surface (drift detection)", () => {
    // Two-direction drift check:
    //   A: every registered extension key must have at least one var(--key)
    //      consumer in the renderer.
    //   B: every var(--key) consumed in the renderer that is not a known
    //      system/local/Tailwind/Radix variable must be a registered
    //      extension key.
    // This is the contract that makes EXTENSION_KEYS the single source of
    // truth for the extension tier.
    const repoRoot = findRepoRoot();
    const { consumed, declared } = scanRendererVars(repoRoot);
    const registered = new Set<string>(EXTENSION_KEYS);

    const directionA = [...registered].filter((k) => !consumed.has(k));
    expect(
      directionA,
      `Extension keys with no var(--key) consumer in src/: ${directionA.join(", ")}`
    ).toHaveLength(0);

    // A var consumed via var(--name) is only an extension-tier candidate if
    // it is NOT declared somewhere in the renderer (statically in CSS as
    // `--name:` or dynamically in a TSX inline style). Locally-declared vars
    // are component-scope cascade intermediates, not theme extension hooks.
    const directionB = [...consumed].filter(
      (v) => !registered.has(v) && !declared.has(v) && !isNonExtensionVar(v)
    );
    expect(
      directionB,
      `var(--key) consumers not registered in EXTENSION_KEYS: ${directionB.join(", ")}`
    ).toHaveLength(0);
  });

  it("never ships a dock-shadow extension that overrides the fix with a weak alpha (#8156)", () => {
    // applyAppThemeToRoot sets extensions["dock-shadow"] as an inline style,
    // which beats the corrected src/index.css base value. Any theme that opts
    // back in must use the alpha-pinned relative-color form so it stays visible
    // on light themes — never a raw low-alpha rgba() like the original bug.
    for (const source of BUILT_IN_THEME_SOURCES) {
      const dockShadow = source.extensions?.["dock-shadow"];
      if (dockShadow === undefined) continue;
      const pinned = dockShadow.match(/rgb\(from var\(--theme-shadow-color\) r g b \/ ([0-9.]+)\)/);
      expect(
        pinned,
        `${source.id} dock-shadow "${dockShadow}" must use the alpha-pinned relative-color form`
      ).toBeTruthy();
      expect(
        Number(pinned![1]),
        `${source.id} dock-shadow alpha ${pinned![1]} below 0.25 visibility threshold`
      ).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("pins the required extension key classification", () => {
    // Second gate over the registry-driven parity test above: flipping a key's
    // `required` flag silently removes its parity/perceptibility protection, so the
    // required set is asserted by name here. Update intentionally, never to silence.
    const required = Object.entries(THEME_EXTENSION_REGISTRY)
      .filter(([, meta]) => meta.required)
      .map(([key]) => key)
      .sort();
    expect(required).toEqual(
      [
        "pulse-missed-bg",
        "pulse-ring-offset",
        "sidebar-active-bg",
        "sidebar-hover-bg",
        "toolbar-control-armed-shadow",
      ].sort()
    );
    expect(
      (THEME_EXTENSION_REGISTRY["toolbar-control-armed-shadow"] as { darkOnly?: boolean }).darkOnly,
      "toolbar-control-armed-shadow must stay darkOnly (light themes inherit the CSS fallback)"
    ).toBe(true);
  });
});

const SEMANTIC_TOKEN_NAMES = new Set<string>(APP_THEME_TOKEN_KEYS);

// CSS variables that are not extension keys and therefore must be excluded
// from the drift scan. This list is intentionally explicit (not prefix-only)
// so that future additions are surfaced for review rather than silently
// shadowed by a too-broad prefix match.
const NON_EXTENSION_VAR_PREFIXES = ["theme-", "color-", "radix-", "tw-", "_"];
const NON_EXTENSION_VAR_NAMES = new Set<string>([
  // Tailwind v4 / shadcn static aliases declared once in src/index.css :root
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "radius",
  "radius-sm",
  "radius-md",
  "radius-lg",
  "radius-xl",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "font-sans",
  "font-mono",
  "font-serif",
]);

function isNonExtensionVar(name: string): boolean {
  if (SEMANTIC_TOKEN_NAMES.has(name)) return true;
  if (NON_EXTENSION_VAR_NAMES.has(name)) return true;
  for (const prefix of NON_EXTENSION_VAR_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function findRepoRoot(): string {
  // Vitest runs with cwd = project root (vitest.config.ts at repo root).
  // Sanity-check by verifying src/ exists; fall back to a walk-up if not.
  const cwd = process.cwd();
  try {
    if (statSync(join(cwd, "src")).isDirectory()) return cwd;
  } catch {
    // fall through
  }
  let current = new URL(".", import.meta.url).pathname;
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(join(current, "src")).isDirectory()) return current;
    } catch {
      // continue walking up
    }
    current = join(current, "..");
  }
  throw new Error("Could not locate repo root (no src/ found from cwd or test file)");
}

function scanRendererVars(repoRoot: string): {
  consumed: Set<string>;
  declared: Set<string>;
} {
  // `declared` is intentionally repo-wide rather than per-file: a var declared
  // anywhere in src/ is treated as locally-managed and excluded from drift
  // Direction B everywhere. This is safe because extension keys are only ever
  // *consumed* via var(--key, fallback); they never have a bare `--key:`
  // declaration in component CSS (themes set them dynamically via
  // applyAppThemeToRoot.setProperty). If that invariant changes — e.g. a
  // theme starts emitting extension vars into a static :root block — this
  // scanner would silently miss the new drift surface.
  const consumed = new Set<string>();
  const declared = new Set<string>();
  const targets: string[] = [];
  walk(join(repoRoot, "src"), targets, (path) => {
    if (path.endsWith(".css")) return true;
    if (path.endsWith(".tsx") || path.endsWith(".ts")) {
      // Skip test files — they can declare arbitrary vars in fixtures.
      if (path.includes(`${"__tests__"}`)) return false;
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
      if (path.endsWith(".spec.ts") || path.endsWith(".spec.tsx")) return false;
      return true;
    }
    return false;
  });

  const varPattern = /var\(--([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  // Static CSS declaration: `--name: ...` at start of a line (any indent).
  const cssDeclPattern = /(?:^|[;{}\s])--([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g;
  // TSX inline-style key: `"--name"` / `'--name'` (covers both bracketed
  // computed keys and plain string keys in style objects).
  const tsxDeclPattern = /["'`]--([a-zA-Z_][a-zA-Z0-9_-]*)["'`]/g;
  // setProperty calls: `setProperty("--name", ...)` and variants.
  const setPropPattern = /setProperty\(\s*["'`]--([a-zA-Z_][a-zA-Z0-9_-]*)["'`]/g;

  for (const file of targets) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Collapse multi-line var(...) so the regex catches names split across
    // lines (e.g. var(\n  --settings-section-header-bg,\n  ...))
    const collapsed = contents.replace(/var\(\s*\n\s+/g, "var(").replace(/var\(\s+/g, "var(");

    for (const match of collapsed.matchAll(varPattern)) {
      const name = match[1];
      if (name) consumed.add(name);
    }
    if (file.endsWith(".css")) {
      for (const match of contents.matchAll(cssDeclPattern)) {
        const name = match[1];
        if (name) declared.add(name);
      }
    } else {
      for (const match of contents.matchAll(tsxDeclPattern)) {
        const name = match[1];
        if (name) declared.add(name);
      }
      for (const match of contents.matchAll(setPropPattern)) {
        const name = match[1];
        if (name) declared.add(name);
      }
    }
  }
  // Self-sanity: if the scanner finds zero vars at all, something is wrong
  // with the walk — fail loudly rather than reporting false-pass drift.
  if (consumed.size === 0) {
    throw new Error(
      `Drift scanner found zero var(--key) consumers under ${relative(repoRoot, join(repoRoot, "src"))}/`
    );
  }
  return { consumed, declared };
}

function walk(dir: string, out: string[], accept: (path: string) => boolean): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build")
        continue;
      walk(path, out, accept);
      continue;
    }
    if (entry.isFile() && accept(path)) out.push(path);
  }
}

function parseAlpha(value: string): number {
  const match = value.match(/rgba?\([^)]*?,\s*([0-9.]+)\s*\)/);
  return match ? Number(match[1]) : NaN;
}

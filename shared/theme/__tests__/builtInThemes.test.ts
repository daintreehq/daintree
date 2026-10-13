import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import {
  DISPLAY_SURFACES,
  blendOverBackground,
  contrastRatio,
  deltaEOK,
  getThemeContrastWarnings,
  getLightThemeMatrixWarnings,
  parseRgba,
} from "../contrast.js";
import type { BuiltInThemeSource } from "../builtInThemeSources.js";
import { EXTENSION_KEY_REGISTRY, isExtensionKeyRequired } from "../extensionRegistry.js";
import { auditSurfaceRamp, auditBorderSeparation, hexToOklch } from "../oklch.js";
import { BUILT_IN_APP_SCHEMES, createDaintreeTokens, normalizeAppColorScheme } from "../themes.js";
import { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES } from "../colorVisionOverrides.js";
import { APP_THEME_TOKEN_KEYS, EXTENSION_KEYS, type AppThemeTokenKey } from "../types.js";

// Minimal hex-only engine input covering createDaintreeTokens' required Pick.
// Deliberately omits border-* and status-*-surface so the engine derives them
// (the knob tests below assert on those derivations).
const LIGHT_ENGINE_INPUT = {
  "surface-canvas": "#f5f8fb",
  "surface-sidebar": "#d8dee6",
  "surface-panel": "#ffffff",
  "surface-panel-elevated": "#ffffff",
  "surface-grid": "#cdd3db",
  "text-primary": "#1a2230",
  "text-secondary": "#3a4658",
  "text-muted": "#6b7686",
  "text-inverse": "#ffffff",
  "border-default": "#c2cad6",
  "accent-primary": "#2f6fed",
  "status-success": "#1f9d57",
  "status-warning": "#c98a17",
  "status-danger": "#d23b3b",
  "status-info": "#2f6fed",
  "activity-active": "#1f9d57",
  "activity-idle": "#9aa4b2",
  "activity-working": "#c98a17",
  "activity-waiting": "#2f6fed",
  "terminal-selection": "#2f6fed",
  "terminal-red": "#d23b3b",
  "terminal-green": "#1f9d57",
  "terminal-yellow": "#c98a17",
  "terminal-blue": "#2f6fed",
  "terminal-magenta": "#a64fd2",
  "terminal-cyan": "#1797a6",
  "terminal-bright-red": "#d23b3b",
  "terminal-bright-green": "#1f9d57",
  "terminal-bright-yellow": "#c98a17",
  "terminal-bright-blue": "#2f6fed",
  "terminal-bright-magenta": "#a64fd2",
  "terminal-bright-cyan": "#1797a6",
  "terminal-bright-white": "#1a2230",
  "syntax-comment": "#6b7686",
  "syntax-punctuation": "#3a4658",
  "syntax-number": "#c98a17",
  "syntax-string": "#1f9d57",
  "syntax-operator": "#3a4658",
  "syntax-keyword": "#a64fd2",
  "syntax-function": "#2f6fed",
  "syntax-link": "#2f6fed",
  "syntax-quote": "#1797a6",
  "syntax-chip": "#3a4658",
} as const;

describe("built-in themes", () => {
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

  it("every status-*-surface token derives as a low-alpha wash, not color-mix(..., transparent)", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const status of ["danger", "success", "warning", "info"] as const) {
        const key = `status-${status}-surface` as const;
        const value = scheme.tokens[key];
        expect(value, `${scheme.id} ${key} should exist`).toBeTruthy();
        // Built-in palettes use hex status colors, so withAlpha emits rgba() —
        // never the color-mix(..., transparent) form that black-shifts on light.
        expect(value, `${scheme.id} ${key} should be an rgba wash`).toMatch(/^rgba\(/);
        const alpha = parseAlpha(value);
        expect(alpha, `${scheme.id} ${key} alpha in (0, 1)`).toBeGreaterThan(0);
        expect(alpha, `${scheme.id} ${key} alpha in (0, 1)`).toBeLessThan(1);
      }
    }
  });

  it("borderInkOverride strategy retints the border ladder without per-token overrides", () => {
    const base = createDaintreeTokens("light", LIGHT_ENGINE_INPUT);
    const warm = createDaintreeTokens("light", LIGHT_ENGINE_INPUT, {
      borderInkOverride: "#3a2a1a",
    });
    // The warm ink composites to a different border value than the cool default,
    // and it propagates across the whole ladder (subtle/strong/divider/interactive).
    for (const key of [
      "border-subtle",
      "border-strong",
      "border-divider",
      "border-interactive",
    ] as const) {
      expect(warm[key], `${key} should shift with borderInkOverride`).not.toBe(base[key]);
    }
  });

  it("statusSurfaceOpacity strategy scales every status-surface alpha", () => {
    const base = createDaintreeTokens("light", LIGHT_ENGINE_INPUT);
    const dimmed = createDaintreeTokens("light", LIGHT_ENGINE_INPUT, {
      statusSurfaceOpacity: 0.5,
    });
    for (const status of ["danger", "success", "warning", "info"] as const) {
      const key = `status-${status}-surface` as const;
      expect(parseAlpha(dimmed[key]), `${key} alpha should halve`).toBeCloseTo(
        parseAlpha(base[key]) * 0.5,
        4
      );
    }
  });

  it("plugin theme that overrides a status color re-derives its surface to match", () => {
    // Raw-token (no palette) path: a plugin sets a custom magenta info color but
    // no explicit surface — the engine must derive a magenta wash, not leak the
    // fallback scheme's (differently-hued) info surface.
    const scheme = normalizeAppColorScheme({ tokens: { "status-info": "#ff00ff" } });
    expect(scheme.tokens["status-info-surface"]).toMatch(/^rgba\(\s*255,\s*0,\s*255,/);
  });

  it("plugin theme keeps an explicit status surface override untouched", () => {
    const scheme = normalizeAppColorScheme({
      tokens: { "status-info": "#ff00ff", "status-info-surface": "rgba(1, 2, 3, 0.5)" },
    });
    expect(scheme.tokens["status-info-surface"]).toBe("rgba(1, 2, 3, 0.5)");
  });

  it("CVD overrides re-derive a status surface for every patched status base color", () => {
    // When a CVD map patches a status base color, it must also patch the
    // matching surface token (consumed directly as bg-status-*-surface), else
    // the pre-baked wash keeps the original — now indistinguishable — hue.
    for (const overrides of [RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES]) {
      for (const status of ["success", "danger", "warning", "info"] as const) {
        const baseHex = overrides[`--theme-status-${status}`];
        if (!baseHex) continue;
        const surface = overrides[`--theme-status-${status}-surface`];
        expect(surface, `surface override missing for status-${status}`).toBeTruthy();
        // The surface must carry the override's own RGB, not an arbitrary value.
        const [r, g, b] = hexToRgbTuple(baseHex);
        expect(surface).toMatch(new RegExp(`^rgba\\(\\s*${r},\\s*${g},\\s*${b},`));
      }
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

      // Cross-key invariant: the selected row must read as MORE prominent than
      // the hovered row. The polarity-correct measure of "more prominent" differs:
      //   - dark: additive white-alpha glow, so stronger = higher alpha.
      //   - light (round-2 Issue 1): opaque elevate-to-select, so stronger = higher
      //     OKLab lightness (selected lifts further toward elevated than hover).
      const hover = extensions["sidebar-hover-bg"];
      const active = extensions["sidebar-active-bg"];
      if (hover !== undefined && active !== undefined) {
        if (polarity === "dark") {
          const hoverAlpha = parseAlpha(hover);
          const activeAlpha = parseAlpha(active);
          if (!(activeAlpha > hoverAlpha)) {
            failures.push(
              `${source.id} sidebar-active-bg (alpha ${activeAlpha}) must be stronger than ` +
                `sidebar-hover-bg (alpha ${hoverAlpha}); values "${active}" vs "${hover}"`
            );
          }
        } else {
          const activeL = hexToOklch(active)?.l;
          const hoverL = hexToOklch(hover)?.l;
          if (activeL === undefined || hoverL === undefined) {
            failures.push(
              `${source.id} light sidebar selection rows must be opaque hex so their lift is ` +
                `measurable; got active="${active}" hover="${hover}"`
            );
          } else if (!(activeL > hoverL)) {
            failures.push(
              `${source.id} light sidebar-active-bg (L ${activeL.toFixed(3)}) must lift above ` +
                `sidebar-hover-bg (L ${hoverL.toFixed(3)}); selected must elevate further than ` +
                `hover (Issue 1); values "${active}" vs "${hover}"`
            );
          }
        }
      }

      // Cross-key invariant: on dark, the toolbar-control armed/active fill
      // must read as MORE prominent than the hover fill, with at least a
      // +0.04 alpha step (#9827). Without this the armed and hover fills
      // both fall through to overlay-emphasis (alpha 0.10) and the only
      // signal separating them is a 1px hairline — the user can't see the
      // toggle is on. Presence is enforced structurally by
      // TOOLBAR_ARMED_FILL in the extension registry (required for dark,
      // forbidWhenNotRequired for light); this block is the relationship
      // check on top of structural enforcement.
      if (polarity === "dark") {
        const toolbarHover = extensions["toolbar-control-hover-bg"];
        const toolbarArmed = extensions["toolbar-control-armed-bg"];
        const toolbarActive = extensions["toolbar-control-active-bg"];
        if (
          toolbarHover !== undefined &&
          toolbarArmed !== undefined &&
          toolbarActive !== undefined
        ) {
          const hoverAlpha = parseAlpha(toolbarHover);
          const armedAlpha = parseAlpha(toolbarArmed);
          const activeAlpha = parseAlpha(toolbarActive);
          if (Number.isNaN(hoverAlpha) || Number.isNaN(armedAlpha) || Number.isNaN(activeAlpha)) {
            failures.push(
              `${source.id} toolbar-control alpha unparseable; got hover="${toolbarHover}" ` +
                `armed="${toolbarArmed}" active="${toolbarActive}"`
            );
          } else {
            if (!(armedAlpha > hoverAlpha)) {
              failures.push(
                `${source.id} toolbar-control-armed-bg (alpha ${armedAlpha}) must be stronger ` +
                  `than toolbar-control-hover-bg (alpha ${hoverAlpha})`
              );
            }
            if (!(activeAlpha > hoverAlpha)) {
              failures.push(
                `${source.id} toolbar-control-active-bg (alpha ${activeAlpha}) must be stronger ` +
                  `than toolbar-control-hover-bg (alpha ${hoverAlpha})`
              );
            }
            if (armedAlpha - hoverAlpha < 0.04 - MIN_STEP_TOLERANCE) {
              failures.push(
                `${source.id} toolbar-control armed-vs-hover alpha step ` +
                  `(${(armedAlpha - hoverAlpha).toFixed(2)}) is below the 0.04 minimum; the ` +
                  `fill separation will be invisible (#9827)`
              );
            }
            if (activeAlpha - hoverAlpha < 0.04 - MIN_STEP_TOLERANCE) {
              failures.push(
                `${source.id} toolbar-control active-vs-hover alpha step ` +
                  `(${(activeAlpha - hoverAlpha).toFixed(2)}) is below the 0.04 minimum; the ` +
                  `fill separation will be invisible (#9827)`
              );
            }
          }
        }
      }

      // Cross-key invariant: toolbar-stats-divider must match toolbar-divider —
      // the stats pill's inter-segment seams use the same separator ink as the
      // rest of the toolbar chrome. Arashiyama drifted by copy-pasting the
      // toolbar-stats-bg fill tint instead, leaving the seams invisible (#10029).
      const toolbarDivider = extensions["toolbar-divider"];
      const statsDivider = extensions["toolbar-stats-divider"];
      const statsBg = extensions["toolbar-stats-bg"];
      if (
        toolbarDivider !== undefined &&
        statsDivider !== undefined &&
        statsDivider !== toolbarDivider
      ) {
        failures.push(
          `${source.id} toolbar-stats-divider ("${statsDivider}") must equal toolbar-divider ` +
            `("${toolbarDivider}"); the stats pill uses the toolbar's separator ink (#10029)`
        );
      }
      if (statsDivider !== undefined && statsDivider === statsBg) {
        failures.push(
          `${source.id} toolbar-stats-divider ("${statsDivider}") matches the toolbar-stats-bg ` +
            `fill tint; the seams would be invisible against the pill fill (#10029)`
        );
      }
      if (statsBg !== undefined && statsDivider === undefined) {
        failures.push(
          `${source.id} styles the stats pill (toolbar-stats-bg) without toolbar-stats-divider; ` +
            `the seams would fall back to --theme-border-subtle instead of the toolbar's ` +
            `separator ink (#10029)`
        );
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
      // Light themes carry depth in the ramp itself, so the JND/span/shape
      // checks are hard failures there (RC-1); dark stays warn-only.
      const result = auditSurfaceRamp(source.palette.surfaces, source.id, source.type);
      for (const warning of result.warnings) {
        console.warn(`[OKLCH ramp] ${warning}`);
      }
      expect(
        result.failures,
        `${source.id} ramp failures:\n${result.failures.join("\n")}`
      ).toHaveLength(0);
    }
  });

  it("light borders clear the separation floor vs the brightest surface", () => {
    // RC-6: when overlay/shadow depth dies on a near-white field, separation
    // falls to borders. border-default and border-interactive must stay
    // perceptible against the brightest surface they can sit against.
    const schemesById = new Map(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const));
    const lightSources = BUILT_IN_THEME_SOURCES.filter((s) => s.type === "light");
    expect(lightSources.length).toBeGreaterThan(0);
    for (const source of lightSources) {
      const scheme = schemesById.get(source.id);
      expect(scheme, `${source.id} has no compiled scheme`).toBeDefined();
      if (!scheme) continue;
      const surfaces: Record<string, string> = {
        "surface-grid": scheme.tokens["surface-grid"],
        "surface-sidebar": scheme.tokens["surface-sidebar"],
        "surface-canvas": scheme.tokens["surface-canvas"],
        "surface-panel": scheme.tokens["surface-panel"],
        "surface-panel-elevated": scheme.tokens["surface-panel-elevated"],
      };
      const result = auditBorderSeparation(
        {
          borderDefault: scheme.tokens["border-default"],
          borderInteractive: scheme.tokens["border-interactive"],
          surfaces,
        },
        source.id,
        "light"
      );
      expect(
        result.failures,
        `${source.id} border separation failures:\n${result.failures.join("\n")}`
      ).toHaveLength(0);
    }
  });

  it("LIGHT themes clear the round-2 selection/elevation validation matrix (hard-fail)", () => {
    // Harden phase: the consolidated round-2 matrix (E6) — activity/pr/scrollbar
    // floors, input/placeholder legibility, filter-selected separation, settings
    // card lift, pulse heat, and the OKLab elevation-direction inversions
    // (sidebar selected lift, grid-bg-below-panel, panel→elevated not smallest) —
    // is now a HARD FAILURE for LIGHT themes. Every check is behavioural: it
    // computes a real contrast ratio / OKLab ΔE / luminance relationship from the
    // resolved token values, never mirrors a literal, so it only fires when the
    // perceptual relationship actually breaks. getLightThemeMatrixWarnings is
    // internally light-scoped (every block either gates appliesTo:"light" or is a
    // both-polarity check that dark already clears), so this loop is safe to run
    // across all schemes — but we restrict the hard assertion to light and merely
    // surface any dark output as a warning to keep dark byte-for-byte unaffected.
    const lightSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type === "light");
    expect(lightSchemes.length).toBeGreaterThan(0);
    for (const scheme of lightSchemes) {
      const warnings = getLightThemeMatrixWarnings(scheme);
      expect(
        warnings,
        `${scheme.id} round-2 matrix failures:\n${warnings.map((w) => w.message).join("\n")}`
      ).toHaveLength(0);
    }
  });

  it("DARK themes emit no round-2 light-matrix failures (warn-only, unaffected)", () => {
    // Guard the dark byte-for-byte invariant: the round-2 matrix must never trip a
    // dark theme. If a future matrix pair forgets its light-scoping this fails loud
    // rather than silently regressing dark.
    const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type === "dark");
    expect(darkSchemes.length).toBeGreaterThan(0);
    for (const scheme of darkSchemes) {
      const warnings = getLightThemeMatrixWarnings(scheme);
      for (const w of warnings) console.warn(`[round-2 matrix:dark] ${scheme.id}: ${w.message}`);
      expect(
        warnings,
        `${scheme.id} unexpectedly tripped the round-2 light matrix:\n${warnings
          .map((w) => w.message)
          .join("\n")}`
      ).toHaveLength(0);
    }
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
  // Stock Tailwind type steps, consumed by name where a size has to be written as
  // a value rather than a utility class (CodeMirror theme objects, the diff
  // text-size preference, the rendered-markdown reading size). The steps below
  // them (--text-2xs/3xs/4xs) are declared in src/index.css, so the `declared`
  // half of the scan already covers those. Stock Tailwind variables are not
  // theme hooks — registering one as an extension key would instead assert it
  // is themable, which Direction A would then hold the palettes to.
  "text-xs",
  "text-sm",
  "text-base",
  "text-lg",
  "text-xl",
  "text-2xl",
  "text-3xl",
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
    // lines (e.g. var(\n  --settings-sidebar-bg,\n  ...))
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

// Epsilon for the toolbar-control alpha-step floor: rgba alpha values are
// specified to 2 decimal places, but the difference of two such values can
// drift below the spec value by a few ULPs of IEEE-754 (e.g. 0.12 - 0.08
// computes as 0.03999999999999999, not 0.04). The tolerance below is
// generous enough to absorb that drift without letting a 0.00 step slip
// through (1e-9 is many orders of magnitude under the 0.01 UI threshold).
const MIN_STEP_TOLERANCE = 1e-9;

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => `${c}${c}`)
          .join("")
      : clean;
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ];
}

describe("bondi", () => {
  /**
   * Bondi is the default light theme, and each of these rules was once broken in
   * a way the shared contrast gate could not see: a colour that clears its budget
   * on the bare surface but not on the surface it actually paints on. They assert
   * the rule, never the hex — any value that keeps the rule passes.
   */
  const bondi = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;
  const token = (key: AppThemeTokenKey) => bondi.tokens[key];

  /** Composite an rgba() or solid token over a background. */
  function paint(value: string, bg: string): string {
    const alpha = parseRgba(value);
    return alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : value;
  }

  const SYNTAX_ROLES = [
    "syntax-comment",
    "syntax-punctuation",
    "syntax-number",
    "syntax-string",
    "syntax-operator",
    "syntax-keyword",
    "syntax-function",
    "syntax-link",
    "syntax-quote",
    "text-primary",
  ] as const satisfies readonly AppThemeTokenKey[];

  // DiffViewer.css paints the word-level edit span inside a line cell that
  // already carries the line wash, so an alpha edit wash stacks on the line
  // wash. The changed characters are the ones a review is about; they must be
  // at least as legible as the code around them.
  it.each([
    ["insert", "diff-insert-background", "diff-insert-edit-background"],
    ["delete", "diff-delete-background", "diff-delete-edit-background"],
  ] as const)("keeps every syntax role at AA on the %s line and word washes", (_, line, edit) => {
    const canvas = token("surface-canvas");
    const lineBg = paint(token(line), canvas);
    const editBg = paint(token(edit), lineBg);
    for (const bg of [lineBg, editBg]) {
      for (const role of SYNTAX_ROLES) {
        const ratio = contrastRatio(token(role), bg);
        expect(
          ratio,
          `${role} ${token(role)} on ${bg} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // Status colours print as text (`+123` counts, the file-tree `M`, error
  // rows) on the sidebar, and as labels on their own 10-15% tint.
  it.each(["status-success", "status-warning", "status-danger", "status-info"] as const)(
    "prints %s at AA on the sidebar and on its own chip tint",
    (key) => {
      const ink = token(key);
      const backgrounds = {
        sidebar: token("surface-sidebar"),
        "15% over panel": blendOverBackground(ink, token("surface-panel"), 0.15),
        "10% over white": blendOverBackground(ink, token("surface-panel-elevated"), 0.1),
      };
      for (const [where, bg] of Object.entries(backgrounds)) {
        const ratio = contrastRatio(ink, bg);
        expect(ratio, `${key} ${ink} on ${where} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          4.5
        );
      }
    }
  );

  // The waiting ring is a thin stroke, so luminance contrast is what makes it
  // the loudest mark on a light field — and it must not read as the warning
  // colour a shade darker.
  it("makes waiting the heaviest status mark and keeps it apart from warning", () => {
    const white = token("surface-panel-elevated");
    const waiting = contrastRatio(token("activity-waiting"), white);
    for (const key of [
      "status-success",
      "status-warning",
      "status-danger",
      "status-info",
    ] as const) {
      expect(waiting, `waiting must out-weigh ${key}`).toBeGreaterThan(
        contrastRatio(token(key), white)
      );
    }
    expect(deltaEOK(token("activity-waiting"), token("status-warning"))).toBeGreaterThanOrEqual(
      0.04
    );
  });

  // ANSI 90 carries hints, timestamps and secondary CLI output: body text.
  it("keeps the terminal dim slot at AA and every base ANSI colour at AA", () => {
    const bg = token("terminal-background");
    for (const key of [
      "terminal-bright-black",
      "terminal-red",
      "terminal-green",
      "terminal-yellow",
      "terminal-blue",
      "terminal-magenta",
      "terminal-cyan",
    ] as const) {
      const ratio = contrastRatio(token(key), bg);
      expect(ratio, `${key} ${token(key)} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // `#panel-grid` paints this extension as background-color, where a gradient
  // is invalid and the gutter silently falls through to the canvas.
  it("gives the panel gutter a plain colour and keeps it below the panels", () => {
    const gutter = bondi.extensions?.["panel-grid-bg"];
    expect(gutter).toMatch(/^#[0-9a-f]{6}$/i);
    // Below the panels by a step a large field reads as a frame; the pane
    // border and ambient shadow carry the edge itself.
    expect(contrastRatio(gutter!, token("surface-panel"))).toBeGreaterThanOrEqual(1.1);
  });
});

describe("border-input", () => {
  /**
   * `border-input` — the resting boundary of `Input` and `Textarea`.
   *
   * Split out of `border-strong` for the same reason `selection-outline` was: an
   * input boundary is a user-interface component under WCAG 1.4.11 and owes 3:1
   * on its own, while `border-strong` is a separation value shared with dividers
   * and card edges that reads as a hard ruled line at that weight. The engine
   * default is therefore whatever `border-strong` resolved to, and a theme moves
   * only by naming the token.
   *
   * These assertions are about the RULE, not the hex: any ink that clears the
   * ratio on both surfaces a field edge touches passes.
   */
  const INPUT_BOUNDARY_MIN_CONTRAST = 3;

  const OPTED_IN = ["daintree", "bondi"] as const;

  it.each(OPTED_IN)("clears 3:1 on %s against both surfaces a field edge touches", (id) => {
    const scheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === id);
    expect(scheme, `${id} scheme`).toBeDefined();
    if (!scheme) return;

    const ink = scheme.tokens["border-input"];
    // The edge sits between the field fill and the panel behind it, so it has to
    // carry the ratio against both — one side alone is not the indicator.
    for (const surface of ["surface-input", "surface-panel"] as const) {
      const bg = scheme.tokens[surface];
      // An alpha ink is composited against the surface it is measured on —
      // which is the whole reason this token wants a solid value: the same
      // rgba() lands on a different colour over the field fill than over the
      // panel, so clearing one side says nothing about the other.
      const alpha = parseRgba(ink);
      const ratio = contrastRatio(
        alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : ink,
        bg
      );
      expect(
        ratio,
        `${id} border-input (${ink}) is ${ratio.toFixed(2)}:1 on ${surface} (${scheme.tokens[surface]}); WCAG 1.4.11 wants ${INPUT_BOUNDARY_MIN_CONTRAST}:1`
      ).toBeGreaterThanOrEqual(INPUT_BOUNDARY_MIN_CONTRAST);
    }
  });

  it("is exactly border-strong on every theme that does not opt in", () => {
    const optedIn = new Set<string>(OPTED_IN);
    const others = BUILT_IN_APP_SCHEMES.filter((s) => !optedIn.has(s.id));
    expect(others.length).toBeGreaterThan(0);
    for (const scheme of others) {
      expect(
        scheme.tokens["border-input"],
        `${scheme.id} must inherit border-strong until it deliberately raises its field edge`
      ).toBe(scheme.tokens["border-strong"]);
    }
  });
});

describe("border-input on a partial import", () => {
  it("follows the resolved border-strong when the import names neither token", async () => {
    // Normalisation seeds a partial theme from a fallback scheme, and that
    // scheme can carry an explicit `border-input` of its own. An import that
    // never mentioned input borders must not inherit another theme's.
    const { normalizeAppColorScheme } = await import("../themes.js");
    const scheme = normalizeAppColorScheme({
      id: "partial-import",
      name: "Partial import",
      type: "dark",
      tokens: { "surface-canvas": "#101010" },
    } as never);
    expect(scheme.tokens["border-input"]).toBe(scheme.tokens["border-strong"]);
  });

  it("keeps an input border the import sets itself", async () => {
    const { normalizeAppColorScheme } = await import("../themes.js");
    const scheme = normalizeAppColorScheme({
      id: "explicit-import",
      name: "Explicit import",
      type: "dark",
      tokens: { "surface-canvas": "#101010", "border-input": "#abcdef" },
    } as never);
    expect(scheme.tokens["border-input"]).toBe("#abcdef");
  });
});

/**
 * `text-placeholder` on the default dark theme.
 *
 * The engine derives this token as `text-primary` at 35% alpha when a theme
 * declares nothing, which put daintree at 2.7–2.8:1 on every display surface —
 * below even this repo's own placeholder floor, which `MATRIX_CONTRAST_PAIRS`
 * sets at a 3:1 graphical tier. Nothing caught it because that pair carries
 * `appliesTo: "light"`, so no dark theme is measured against it.
 *
 * These assertions are about the RULE, not the value: any hex that keeps
 * placeholders legible on every surface passes, and the test says nothing about
 * which hex that is. What it refuses is the two ways this regressed before —
 * dropping back to the alpha derivation, and drifting under the floor.
 */
describe("daintree text-placeholder", () => {
  const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree");

  it("declares the token solid rather than inheriting the alpha derivation", () => {
    // An alpha text colour bakes into `color-mix()` on `color`, and the design
    // system bans slash-alpha text precisely because the contrast cannot then
    // be recovered downstream. A solid token is the only correctable form.
    const raw = daintree?.tokens["text-placeholder"];
    expect(raw).toBeDefined();
    expect(parseRgba(raw as string)).toBeNull();
  });

  it("clears the placeholder floor on every display surface", () => {
    const raw = daintree?.tokens["text-placeholder"] as string;

    const failures: string[] = [];
    for (const surface of DISPLAY_SURFACES) {
      const bg = daintree?.tokens[surface];
      if (!bg) continue;

      const alpha = parseRgba(raw);
      const fg = alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : raw;
      const ratio = contrastRatio(fg, bg);

      // 3:1, matching `MATRIX_CONTRAST_PAIRS` — this repo treats placeholder as
      // a graphical-tier de-emphasis, not 4.5:1 body text. That tier is the
      // house position and it outranks the stricter external reading: a
      // placeholder that clears AA stops receding from `text-muted`, which the
      // role ramp in `scripts/theme-text-contrast.test.ts` requires it to do.
      // The derivation this replaced sat at 2.7-2.8:1, under even this floor.
      if (ratio < 3) failures.push(`${surface}: ${ratio.toFixed(2)}:1`);
    }

    expect(failures).toEqual([]);
  });

  it("recedes from text-muted, so the role ramp keeps its order", () => {
    // The ramp is primary > secondary > muted > placeholder. A placeholder that
    // outruns muted inverts it, and "nearest role" stops meaning anything.
    const placeholder = daintree?.tokens["text-placeholder"] as string;
    const muted = daintree?.tokens["text-muted"] as string;

    for (const surface of DISPLAY_SURFACES) {
      const bg = daintree?.tokens[surface];
      if (!bg) continue;
      expect(contrastRatio(placeholder, bg)).toBeLessThan(contrastRatio(muted, bg));
    }
  });
});

describe("segmented selection boundary", () => {
  /**
   * The selected segment of `SegmentedRadioGroup` (the settings scope switch, every
   * settings preset row, the create-worktree mode switches) is marked by a
   * `text-secondary` boundary on the `surface-inset` track. Its fill barely moves off the
   * track, so the boundary is the state indicator WCAG 1.4.11 asks 3:1 of. The rule, not
   * the hex: any theme whose secondary ink clears the ratio on its inset track passes.
   */
  const SELECTION_INDICATOR_MIN_CONTRAST = 3;

  it.each(BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "clears 3:1 against the inset track on %s",
    (_id, scheme) => {
      const ink = scheme.tokens["text-secondary"];
      const inset = scheme.tokens["surface-inset"];
      // Dark themes author the track as a wash, so it is measured where the control
      // actually sits: on a settings group (panel-elevated) and on a bare panel.
      for (const surface of ["surface-panel-elevated", "surface-panel"] as const) {
        const base = scheme.tokens[surface];
        const insetAlpha = parseRgba(inset);
        const track = insetAlpha
          ? blendOverBackground(insetAlpha.hex, base, insetAlpha.opacity)
          : inset;
        const inkAlpha = parseRgba(ink);
        const ratio = contrastRatio(
          inkAlpha ? blendOverBackground(inkAlpha.hex, track, inkAlpha.opacity) : ink,
          track
        );
        expect(
          ratio,
          `${scheme.id}: text-secondary (${ink}) is ${ratio.toFixed(2)}:1 on the inset track over ${surface}`
        ).toBeGreaterThanOrEqual(SELECTION_INDICATOR_MIN_CONTRAST);
      }
    }
  );
});

describe("pulse heat ramp — every painted step is visibly distinct", () => {
  // Clearly above the ~0.02 JND: a level-1 day that only just clears JND still
  // reads as a quiet day at 10px, and a level 3 that only just clears it reads as
  // a peak — the two defects this guards against.
  const MIN_STEP_DELTA_E = 0.05;

  const HEX = /^#[0-9A-Fa-f]{6}$/;
  const STOPS = ["pulse-heat-1", "pulse-heat-2", "pulse-heat-3", "pulse-heat-4"] as const;

  // Mirrors PulseHeatmap's fallback defaults for a theme that authors only the
  // hue: the cell paints `pulse-heat-color` at each opacity over the card.
  const LEGACY_OPACITY_DEFAULTS = { low: 0.18, medium: 0.35, high: 0.55 };

  /**
   * The ramp a theme actually paints, empty cell first. Opaque stops when the
   * theme authors all four; otherwise the legacy alpha ramp composited over the
   * card. `null` when neither is resolvable to hex.
   */
  function paintedRamp(theme: BuiltInThemeSource): string[] | null {
    const ext = theme.extensions ?? {};
    const empty = ext["pulse-empty-bg"];
    if (!empty || !HEX.test(empty)) return null;

    const opaque = STOPS.map((key) => ext[key]);
    if (opaque.every((stop): stop is string => stop !== undefined && HEX.test(stop))) {
      return [empty, ...opaque];
    }

    const color = ext["pulse-heat-color"];
    const card = ext["pulse-card-bg"];
    if (!color || !HEX.test(color) || !card || !HEX.test(card)) return null;
    const opacity = (key: string, fallback: number) => {
      const value = Number(ext[key as keyof typeof ext]);
      return Number.isFinite(value) ? value : fallback;
    };
    return [
      empty,
      blendOverBackground(
        color,
        card,
        opacity("pulse-heat-low-opacity", LEGACY_OPACITY_DEFAULTS.low)
      ),
      blendOverBackground(
        color,
        card,
        opacity("pulse-heat-medium-opacity", LEGACY_OPACITY_DEFAULTS.medium)
      ),
      blendOverBackground(
        color,
        card,
        opacity("pulse-heat-high-opacity", LEGACY_OPACITY_DEFAULTS.high)
      ),
      color,
    ];
  }

  const ramps = BUILT_IN_THEME_SOURCES.map((theme) => [theme.id, paintedRamp(theme)] as const);

  it("resolves a ramp for every built-in theme that styles the pulse", () => {
    const styled = BUILT_IN_THEME_SOURCES.filter((t) => t.extensions?.["pulse-empty-bg"]);
    expect(styled.length).toBeGreaterThan(0);
    for (const theme of styled) {
      expect(paintedRamp(theme), `${theme.id} has no resolvable heat ramp`).not.toBeNull();
    }
  });

  it.each(ramps.filter(([, ramp]) => ramp !== null))(
    "%s: empty → heat-1 → … → heat-4 each step clears the floor",
    (id, ramp) => {
      for (let i = 1; i < ramp!.length; i += 1) {
        expect(
          deltaEOK(ramp![i - 1]!, ramp![i]!),
          `${id}: step ${i - 1}→${i} (${ramp![i - 1]} → ${ramp![i]})`
        ).toBeGreaterThanOrEqual(MIN_STEP_DELTA_E);
      }
    }
  );
});

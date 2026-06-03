import { EXTENSION_KEYS, type ExtensionKey } from "./types.js";

type ColorMode = "dark" | "light";

/**
 * Per-extension-key governance metadata. The parity loop in
 * shared/theme/__tests__/builtInThemes.test.ts iterates EXTENSION_KEYS and
 * applies these rules:
 *
 * - `required` true / false / fn(mode) controls whether every theme of a given
 *   polarity must provide a value. The fn form encodes polarity-conditional
 *   requirements (e.g. dark-only).
 * - `forbidWhenNotRequired` asserts the inverse for the polarity where
 *   `required(mode)` is false — used when a copy-paste from the opposite
 *   polarity would render incorrectly (e.g. a white-tinted hairline on a
 *   light toolbar inverts the original bug).
 * - `perceptibility` validates a present value matches the polarity-tint
 *   regex and clears a minimum alpha threshold per polarity.
 * - `formatGuard` validates the literal CSS form of the value when present,
 *   used for keys whose value must use a specific syntax (e.g. the
 *   `rgb(from var(--theme-shadow-color) r g b / X)` form so the shadow
 *   stays visible on light themes).
 */
export interface ExtensionKeyMetadata {
  required: boolean | ((mode: ColorMode) => boolean);
  forbidWhenNotRequired?: boolean;
  perceptibility?: {
    minAlpha?: Partial<Record<ColorMode, number>>;
    maxAlpha?: Partial<Record<ColorMode, number>>;
    expectedTint?: Partial<Record<ColorMode, RegExp>>;
  };
  formatGuard?: RegExp;
  minFormatAlpha?: number;
}

const OPTIONAL: ExtensionKeyMetadata = { required: false };

// Round-2 selection-direction flip (Issue 1): on LIGHT, the selected/hovered
// sidebar row must ELEVATE toward an opaque brighter surface (panel/canvas) — a
// darkening rgba(0,0,0,*) reads as grime on near-white, not lift. So the light
// governance now expects an opaque hex (no black-alpha tint, no alpha floor) and
// the lift relationship is enforced behaviourally by the OKLab idle<hover<selected
// audit in builtInThemes.test.ts. DARK is unchanged: selection is still an additive
// white-alpha glow, so dark keeps the rgba(255,255,255,*) tint + alpha floors.
const SIDEBAR_HOVER: ExtensionKeyMetadata = {
  required: true,
  perceptibility: {
    minAlpha: { dark: 0.03 },
    expectedTint: {
      dark: /rgba\(\s*255\s*,\s*255\s*,\s*255/,
      light: /^#[0-9a-fA-F]{6}$/,
    },
  },
};

const SIDEBAR_ACTIVE: ExtensionKeyMetadata = {
  required: true,
  perceptibility: {
    minAlpha: { dark: 0.05 },
    expectedTint: {
      dark: /rgba\(\s*255\s*,\s*255\s*,\s*255/,
      light: /^#[0-9a-fA-F]{6}$/,
    },
  },
};

// toolbar-control-armed-shadow is the inset ring on armed toolbar controls
// (dropdown open / toggle on). The CSS fallback in toolbar.css is now
// `inset 0 0 0 1px var(--theme-border-strong)` — the cool borderInk slate,
// which is contrast-floored and polarity-correct on BOTH modes, replacing the
// old hardcoded rgba(0,0,0,0.18) that went near-invisible on dark and read as a
// black hairline on light (round-2 Issue 2 / Pattern B). Because the fallback
// is now correct on light, light themes inherit it and must NOT ship their own
// override (forbidWhenNotRequired) — a white-tinted ring copy-pasted from dark
// would invert the original #8175 bug on a light toolbar. Dark themes still
// REQUIRE a per-theme white-tinted override: border-strong is a valid fallback
// there too, but the curated white ring reads crisper on dark chrome, so the
// dark requirement is retained for fidelity (the perceptibility/format guards
// below police those dark override values).
const TOOLBAR_ARMED: ExtensionKeyMetadata = {
  required: (mode) => mode === "dark",
  forbidWhenNotRequired: true,
  perceptibility: {
    minAlpha: { dark: 0.08 },
    maxAlpha: { dark: 0.25 },
    expectedTint: { dark: /rgba\(\s*255\s*,\s*255\s*,\s*255/ },
  },
  formatGuard: /inset\s+0\s+0\s+0\s+1px/,
};

const DOCK_SHADOW: ExtensionKeyMetadata = {
  required: false,
  formatGuard: /rgb\(from var\(--theme-shadow-color\) r g b \/ ([0-9.]+)\)/,
  minFormatAlpha: 0.25,
};

export const EXTENSION_KEY_REGISTRY = {
  // Chrome material
  "chrome-bg": OPTIONAL,
  "chrome-noise": OPTIONAL,
  "chrome-shadow": OPTIONAL,

  // Dialog + floating surface
  "dialog-bg": OPTIONAL,
  "dialog-header-bg": OPTIONAL,
  "dialog-shadow": OPTIONAL,
  "floating-surface-bg": OPTIONAL,
  "floating-surface-shadow": OPTIONAL,

  // Dock
  "dock-bg": OPTIONAL,
  "dock-border": OPTIONAL,
  "dock-shadow": DOCK_SHADOW,

  // Panel grid
  "panel-grid-bg": OPTIONAL,
  "terminal-grid-bg": OPTIONAL,

  // Pulse
  "pulse-before-bg": OPTIONAL,
  "pulse-card-bg": OPTIONAL,
  "pulse-card-header-bg": OPTIONAL,
  "pulse-card-shadow": OPTIONAL,
  "pulse-control-hover-bg": OPTIONAL,
  "pulse-empty-bg": OPTIONAL,
  "pulse-heat-color": OPTIONAL,
  "pulse-heat-1": OPTIONAL,
  "pulse-heat-2": OPTIONAL,
  "pulse-heat-3": OPTIONAL,
  "pulse-heat-4": OPTIONAL,
  "pulse-heat-high-opacity": OPTIONAL,
  "pulse-heat-low-opacity": OPTIONAL,
  "pulse-heat-medium-opacity": OPTIONAL,
  "pulse-missed-bg": OPTIONAL,
  "pulse-range-bg": OPTIONAL,
  "pulse-ring-offset": OPTIONAL,
  "pulse-skeleton-gradient": OPTIONAL,

  // Settings
  "settings-card-bg": OPTIONAL,
  "settings-dialog-bg": OPTIONAL,
  "settings-kbd-bg": OPTIONAL,
  "settings-kbd-border": OPTIONAL,
  "settings-list-item-bg": OPTIONAL,
  "settings-meta-fg": OPTIONAL,
  "settings-meta-size": OPTIONAL,
  "settings-nav-active-bg": OPTIONAL,
  "settings-nav-active-shadow": OPTIONAL,
  "settings-nav-hover-bg": OPTIONAL,
  "settings-search-bg": OPTIONAL,
  "settings-search-muted": OPTIONAL,
  "settings-section-header-bg": OPTIONAL,
  "settings-section-header-bg-solid": OPTIONAL,
  "settings-sidebar-bg": OPTIONAL,

  // Sidebar — required keys whose CSS fallback (white-tint) is invisible on
  // light themes. See #8175 lineage.
  "sidebar-action-hover-bg": OPTIONAL,
  "sidebar-active-bg": SIDEBAR_ACTIVE,
  "sidebar-hover-bg": SIDEBAR_HOVER,

  // Toolbar — toolbar-control-armed-shadow is polarity-conditional. The CSS
  // fallback is now border-strong (cool borderInk, correct on both modes), so
  // light themes inherit it; they must NOT add a white-ring override (that
  // would invert the original #8175 bug on a light toolbar). Dark themes still
  // ship a per-theme white-tinted ring for crispness on dark chrome.
  "toolbar-agent-hover-bg": OPTIONAL,
  "toolbar-bg": OPTIONAL,
  "toolbar-control-active-bg": OPTIONAL,
  "toolbar-control-armed-bg": OPTIONAL,
  "toolbar-control-armed-shadow": TOOLBAR_ARMED,
  "toolbar-control-hover-bg": OPTIONAL,
  "toolbar-control-hover-fg": OPTIONAL,
  "toolbar-control-hover-shadow": OPTIONAL,
  "toolbar-divider": OPTIONAL,
  "toolbar-noise": OPTIONAL,
  "toolbar-pill-radius": OPTIONAL,
  "toolbar-shadow": OPTIONAL,

  // Toolbar project pill
  "toolbar-project-bg": OPTIONAL,
  "toolbar-project-border": OPTIONAL,
  "toolbar-project-chip-bg": OPTIONAL,
  "toolbar-project-chip-border": OPTIONAL,
  "toolbar-project-chip-size": OPTIONAL,
  "toolbar-project-meta-fg": OPTIONAL,
  "toolbar-project-shadow": OPTIONAL,

  // Toolbar stats pill
  "toolbar-stats-bg": OPTIONAL,
  "toolbar-stats-border": OPTIONAL,
  "toolbar-stats-divider": OPTIONAL,
  "toolbar-stats-hover-bg": OPTIONAL,
  "toolbar-stats-shadow": OPTIONAL,

  // Worktree section
  "worktree-section-hover-bg": OPTIONAL,
  "worktree-filter-bar-bg": OPTIONAL,
} as const satisfies Record<ExtensionKey, ExtensionKeyMetadata>;

export function isExtensionKeyRequired(key: ExtensionKey, mode: ColorMode): boolean {
  const meta = EXTENSION_KEY_REGISTRY[key];
  return typeof meta.required === "function" ? meta.required(mode) : meta.required;
}

// Re-export for callers that want both the canonical list and the registry
// from a single module.
export { EXTENSION_KEYS };

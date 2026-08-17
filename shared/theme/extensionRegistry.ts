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

// toolbar-control-hover-bg / toolbar-control-armed-bg / toolbar-control-active-bg
// are polarity-conditional. On DARK, all three are required: without the
// hover/armed/active overrides the CSS fallback to --theme-overlay-emphasis
// (alpha 0.10) collapses armed and hover to the same fill, leaving only a 1px
// hairline to signal the toggle (#9827). Per-theme tints differ (white,
// green, warm, sand, cool slate, cream), so no expectedTint regex is
// enforced at the registry level — the per-key alpha range + the
// builtInThemes.test.ts relationship check together defend the spec.
//
// toolbar-control-hover-bg is also set by every light theme (their armed/
// hover separation comes from #8175), so the hover key carries no
// forbidWhenNotRequired — the existing light values are valid. Only the
// armed/active pair forbids light overrides: a dark white-alpha copy-paste
// would invert the layer order on a light toolbar.
const TOOLBAR_HOVER_FILL: ExtensionKeyMetadata = {
  required: (mode) => mode === "dark",
  perceptibility: {
    minAlpha: { dark: 0.05 },
    maxAlpha: { dark: 0.2 },
  },
};

const TOOLBAR_ARMED_FILL: ExtensionKeyMetadata = {
  required: (mode) => mode === "dark",
  forbidWhenNotRequired: true,
  perceptibility: {
    minAlpha: { dark: 0.05 },
    maxAlpha: { dark: 0.3 },
  },
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
  // QuickRun command-input fill. The CSS fallback is the overlay-soft ink wash
  // (correct on dark); light themes lift the field to a raised input plane.
  "dock-input-bg": OPTIONAL,
  // Dock item fills/borders. These shadow same-named :root declarations in
  // src/index.css; the theme's inline var on <html> wins the cascade, and the
  // :root values (idle overlay-subtle, accent@12% active fill, accent@0.32
  // active border) are the fallbacks when a theme omits the keys. Light themes
  // can replace the accent-tinted active fill with a lift-toward-white plane.
  "dock-item-bg": OPTIONAL,
  "dock-item-bg-active": OPTIONAL,
  "dock-item-border-active": OPTIONAL,
  "dock-shadow": DOCK_SHADOW,

  // Grid grain texture. NOT authored directly by built-ins — resolved from
  // strategy.grainCharacter (palette.ts) into a curated SVG data-URI or `none`.
  // Conditionally emitted: unset/"fine" emits no var so the CSS fallback keeps
  // the bundled noise.png (see resolveGrainImage in themes.ts).
  "grain-image": OPTIONAL,

  // Panel title bars. Fallbacks are transparent (idle) and overlay-subtle
  // (focused) — dark themes render unchanged without the keys.
  "panel-header-bg": OPTIONAL,
  "panel-header-focus-bg": OPTIONAL,

  // Panel focus chrome — the focused/selected pane's border ink
  // (panel-focus-border), double-ring glow stack (panel-focus-shadow), and
  // fill (panel-selected-bg). Consumed by .terminal-selected /
  // .terminal-selected-quiet / .assistant-focused / .terminal-focused in
  // src/index.css with today's color-mix recipes as fallbacks. The quiet
  // variant reads the border and shadow keys but never the fill, by design.
  // Values are full CSS expressions, so no
  // perceptibility guard applies. Accent budget: focus IS the load-bearing
  // signal per focus region, so accent-family ink here is legitimate — but a
  // theme inking focus chrome from its accent family must NOT also carry
  // another accent fill in the panel region. The `prefers-contrast: more` and
  // `forced-colors: active` blocks in src/index.css keep their hardcoded
  // system-color recipes and continue to win over these keys — never "unify"
  // them into this extension surface.
  "panel-focus-border": OPTIONAL,
  "panel-focus-shadow": OPTIONAL,
  "panel-selected-bg": OPTIONAL,

  // Panel grid. Both keys accept full CSS `background` shorthand (gradients
  // included), not just a flat color. The audited flat `surfaces.grid` token
  // remains the contrast/ramp source of truth: a gradient value must keep the
  // flat hex as its final layer, and the boot splash skeleton reads the flat
  // --theme-surface-grid directly, so boot theming is unaffected by gradients
  // here.
  "panel-grid-bg": OPTIONAL,
  "terminal-grid-bg": OPTIONAL,

  // Project identity tiles. The CSS fallbacks are the original black-wash
  // gradient + dark inset shadow (correct on dark); light themes flip the
  // wash to a white-gloss lift so the emoji chips read bright, not murky.
  "project-tile-shadow": OPTIONAL,
  "project-tile-wash": OPTIONAL,

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
  "pulse-range-bg": OPTIONAL,
  "pulse-ring-offset": OPTIONAL,
  "pulse-skeleton-gradient": OPTIONAL,
  // Streak-flame tiers, shortest to longest. The consumer bakes the current
  // ramp in as a fallback, so a theme that leaves these unset renders the same
  // flame it always did.
  "pulse-streak-1": OPTIONAL,
  "pulse-streak-2": OPTIONAL,
  "pulse-streak-3": OPTIONAL,
  "pulse-streak-4": OPTIONAL,
  "pulse-streak-5": OPTIONAL,
  "pulse-streak-6": OPTIONAL,
  "pulse-streak-7": OPTIONAL,

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
  // Scope (Global/Project) select trigger fill; transparent fallback.
  "settings-scope-bg": OPTIONAL,
  "settings-search-bg": OPTIONAL,
  "settings-search-muted": OPTIONAL,
  "settings-section-header-bg": OPTIONAL,
  "settings-section-header-bg-solid": OPTIONAL,
  "settings-sidebar-bg": OPTIONAL,
  // Scroll-fade color for the settings sidebar's ScrollShadow. Only needed by
  // themes that author a custom settings-sidebar-bg; the CSS fallback in
  // settings.css composites the default 50% canvas wash over the dialog shell.
  "settings-sidebar-scroll-fade": OPTIONAL,

  // Sidebar — required keys whose CSS fallback (white-tint) is invisible on
  // light themes. See #8175 lineage.
  "sidebar-action-hover-bg": OPTIONAL,
  "sidebar-active-bg": SIDEBAR_ACTIVE,
  // r3 white-cards-on-sky primitives: the idle worktree card lifts to an
  // opaque near-white plane (light themes opt in; dark themes leave the card
  // transparent and keep the additive hover/active ladder).
  "sidebar-card-bg": OPTIONAL,
  "sidebar-card-shadow": OPTIONAL,
  "sidebar-hover-bg": SIDEBAR_HOVER,

  // Toolbar — toolbar-control-armed-shadow is polarity-conditional. The CSS
  // fallback is now border-strong (cool borderInk, correct on both modes), so
  // light themes inherit it; they must NOT add a white-ring override (that
  // would invert the original #8175 bug on a light toolbar). Dark themes still
  // ship a per-theme white-tinted ring for crispness on dark chrome.
  "toolbar-agent-hover-bg": OPTIONAL,
  "toolbar-bg": OPTIONAL,
  "toolbar-control-active-bg": TOOLBAR_ARMED_FILL,
  "toolbar-control-armed-bg": TOOLBAR_ARMED_FILL,
  "toolbar-control-armed-shadow": TOOLBAR_ARMED,
  "toolbar-control-hover-bg": TOOLBAR_HOVER_FILL,
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

  // Review hub — commit-message field fill. The CSS fallback is the canvas
  // tone (correct on dark); light themes lift the field to a raised plane.
  "review-commit-input-bg": OPTIONAL,

  // Welcome screen. welcome-field-wash is a full CSS `background` shorthand
  // layered behind the welcome layout (fallback `none` = today's chrome);
  // welcome-mark-color tints the brand mark (fallback: tint at 50%). The
  // welcome screen carries real text: washes stay whisper-alpha (≤8%) and the
  // existing text alphas must still clear their contrast floors over the
  // composited wash — a design-review gate, not a regex (gradient strings
  // defeat perceptibility regexes).
  "welcome-field-wash": OPTIONAL,
  "welcome-mark-color": OPTIONAL,

  // Worktree section
  "worktree-section-hover-bg": OPTIONAL,
  "worktree-filter-bar-bg": OPTIONAL,
  // Active quick-state segment fill. The CSS fallback is the overlay-subtle
  // darkening wash (correct on dark); light themes lift the active tab toward
  // white so selection elevates instead of receding.
  "worktree-quick-state-active-bg": OPTIONAL,
  "worktree-search-input-bg": OPTIONAL,
} as const satisfies Record<ExtensionKey, ExtensionKeyMetadata>;

export function isExtensionKeyRequired(key: ExtensionKey, mode: ColorMode): boolean {
  const meta = EXTENSION_KEY_REGISTRY[key];
  return typeof meta.required === "function" ? meta.required(mode) : meta.required;
}

// Re-export for callers that want both the canonical list and the registry
// from a single module.
export { EXTENSION_KEYS };

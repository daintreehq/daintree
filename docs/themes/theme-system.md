# Theme System

Daintree's theming system is a three-layer pipeline shared between the renderer and main process:

1. `ThemePalette` Theme authors define the visual foundation in `shared/theme/palette.ts`: surfaces, text, accent, status, activity, terminal colors, syntax colors, and a small `strategy` object.
2. Semantic tokens `createSemanticTokens()` in `shared/theme/semantic.ts` compiles a palette into the stable app token contract (`AppColorSchemeTokens` in `shared/theme/types.ts`). Internally this calls `createDaintreeTokens()` in `shared/theme/themes.ts` which derives ~145 tokens (the full `APP_THEME_TOKEN_KEYS` contract) from ~40 required palette inputs.
3. Component public vars Individual UI areas expose their own override surface through CSS variables such as `--toolbar-bg`, `--toolbar-project-bg`, `--settings-dialog-bg`, `--pulse-card-bg`, and `--panel-grid-bg`.

## Core Model

- `AppColorScheme` is the canonical theme object: `id`, `name`, `type`, `builtin`, `palette`, `tokens`, and optional `extensions`.
- Built-in themes are authored as individual files in `shared/theme/builtInThemes/`, each exporting a `BuiltInThemeSource`.
- `shared/theme/builtInThemes/index.ts` assembles the `BUILT_IN_THEME_SOURCES` array.
- `shared/theme/themes.ts` compiles those sources into `BUILT_IN_APP_SCHEMES` via `createThemeFromSource()`.
- The public semantic token contract lives in `APP_THEME_TOKEN_KEYS` in `shared/theme/types.ts`.

## Built-In Themes

14 built-in themes, each in its own file under `shared/theme/builtInThemes/`:

| Theme          | File                | Type  |
| -------------- | ------------------- | ----- |
| Daintree       | `daintree.ts`       | dark  |
| Arashiyama     | `arashiyama.ts`     | dark  |
| Fiordland      | `fiordland.ts`      | dark  |
| Galapagos      | `galapagos.ts`      | dark  |
| Highlands      | `highlands.ts`      | dark  |
| Namib          | `namib.ts`          | dark  |
| Redwoods       | `redwoods.ts`       | dark  |
| Bondi          | `bondi.ts`          | light |
| Table Mountain | `table-mountain.ts` | light |
| Atacama        | `atacama.ts`        | light |
| Bali           | `bali.ts`           | light |
| Hokkaido       | `hokkaido.ts`       | light |
| Serengeti      | `serengeti.ts`      | light |
| Svalbard       | `svalbard.ts`       | light |

Built-in themes use one source of truth: `palette` plus optional semantic token overrides (`tokens`) and optional component extensions (`extensions`). There is no separate recipe-token layer.

The `BuiltInThemeSource` interface:

```typescript
interface BuiltInThemeSource {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: true;
  palette: ThemePalette;
  tokens?: Partial<AppColorSchemeTokens>; // override derived semantic tokens
  extensions?: Partial<Record<ExtensionKey, string>>; // component-level CSS variable overrides (keys constrained to the ExtensionKey union)
  location?: string;
  heroImage?: string;
}
```

## Semantic Tokens

Semantic tokens are app-wide values exposed as `--theme-*` CSS variables. The full token set is documented in [theme-tokens.md](./theme-tokens.md). Key groups:

- Surfaces: `surface-canvas`, `surface-sidebar`, `surface-toolbar`, `surface-panel`, `surface-panel-elevated`, `surface-grid`, `surface-input`, `surface-inset`, `surface-hover`, `surface-active`
- Text, border, accent (primary + optional secondary lane), status, activity
- Overlay ladder (tintable via `overlay-base`), atmospheric wash, scrim (colors plus the `scrim-blur` / `scrim-blur-palette` backdrop depths)
- Shadow profiles (`shadow-ambient`, `shadow-floating`, `shadow-dialog`)
- Material/radius strategy outputs (`material-blur`, `material-saturation`, `material-opacity`, `radius-scale`)
- Terminal (first-class, independent of workbench), syntax highlighting
- GitHub states, search highlighting, diff viewer, category hues
- UI utility tokens: scrollbar, panel state edge, focus ring offset, chrome noise texture, grid grain (`grain-opacity` / `grain-blend`), state chip/label pill opacities

Component-specific styling does not belong in this layer.

## Component Overrides

**See [Canonical Interaction State Recipes](./interaction-state-recipes.md)** for hover/focus implementation patterns when working with component overrides.

Component CSS owns the public override surface. Themes can target specific UI regions through `extensions` without expanding the global semantic contract. The allowed extension keys are the typed `ExtensionKey` union (`EXTENSION_KEYS` in `shared/theme/types.ts`), gated and classified OPTIONAL vs REQUIRED by the registry in `shared/theme/extensionRegistry.ts` (e.g. `panel-grid-bg` is registered there and consumed in `src/index.css`).

| Component | File | Variable prefix |
| --- | --- | --- |
| Toolbar | `src/styles/components/toolbar.css` | `--toolbar-*` |
| Sidebar / Worktree | `src/styles/components/sidebar.css` | `--sidebar-*`, `--worktree-*` |
| Settings | `src/styles/components/settings.css` | `--settings-*` |
| Pulse | `src/styles/components/pulse.css` | `--pulse-*` |
| Panel shell | `src/styles/components/panels.css` | `--chrome-*`, `--dialog-*`, `--floating-surface-*` |

Pattern:

```css
.toolbar-project-pill {
  --_bg: var(--toolbar-project-bg, var(--theme-wash-medium));
  --_border: var(--toolbar-project-border, var(--theme-border-subtle));
  --_shadow: var(--toolbar-project-shadow, var(--theme-shadow-ambient));
}
```

The app owns layout, spacing, and animation timing. Themes own color, shadow, material, and component chrome.

Extensions are applied as bare CSS custom properties on `:root` (e.g., `"toolbar-project-bg": "..."` becomes `--toolbar-project-bg`). Themes that don't need custom component styling can omit extensions entirely — the CSS fallbacks provide sensible defaults.

## Runtime Application

- `getAppThemeCssVariables()` in `shared/theme/themes.ts` converts a scheme into CSS variables.
- `applyAppThemeToRoot()` in `src/theme/applyAppTheme.ts` applies those variables to the root element, clears stale extension vars between switches, and sets `data-theme`, `data-colorMode`, `color-scheme`, and `.dark`/`.light` classes.
- `applyColorVisionMode()` (in `src/theme/applyAppTheme.ts`) overrides 39 tokens for colorblind simulation ("red-green" and "blue-yellow" modes). The override tables live in `shared/theme/colorVisionOverrides.ts` (`RED_GREEN_OVERRIDES`, `BLUE_YELLOW_OVERRIDES`, and the union `ALL_CVD_TOKENS`).
- Tailwind-facing aliases live in `src/index.css`.

## Import Flow

- App theme import is handled by `electron/utils/appThemeImporter.ts`.
- Imported theme files may provide:
  - a `palette`
  - optional semantic `tokens`
  - optional component `extensions`
- Unknown nested tokens are ignored with warnings.
- Missing `type` is inferred from `surface-canvas` when possible.

## Guidance

- Add a semantic token only when the value is genuinely app-wide.
- Add a component public var when a visual decision belongs to one shell or component family.
- Do not add recipe-style theme tokens or alias compatibility layers.
- Keep terminal colors first-class and independent from workbench surfaces.
- Keep search highlighting independent from accent when a theme needs it.

## Design review checklist

Before adding a file to `DURABLE_ALLOWLIST` in `src/config/__tests__/accentGuard.contract.test.ts`, answer all four questions:

1. **Is the accent the user's primary action target in this view?** If accent marks a secondary indicator, badge, or membership state, it fails.
2. **Does it survive grayscale?** Open Chrome DevTools → Rendering → Emulate vision deficiency: achromatopsia. If the primary CTA stops reading as primary, the view is overusing accent.
3. **Is it a singleton in its active focus region?** An active focus region is an independent focus trap or arrow-key navigation domain (macro layout zone, modal, popover, dropdown). Only one accent consumer per region. When focus regions overlay (modal over popover over panel), only the topmost active region claims accent; background regions defer to neutral alternatives (`bg-overlay-subtle`, focus styling).
4. **Is there a neutral lift alternative?** Preference order: title-bar lift (`bg-overlay-subtle`), focus styling, neutral surface difference. Only use accent when every neutral alternative fails the legibility test.

### Grayscale Test

Chrome DevTools → Rendering → Emulate vision deficiency: achromatopsia. This is the definitive check for accent overuse. The primary CTA must remain visually dominant even when color is removed. If removing color collapses the hierarchy, the design relies too heavily on accent.

### Theme material review (panel focus chrome, grid/chrome materials)

Additional checks when reviewing a theme that authors the material extension keys:

1. **Focus chrome vs accent budget.** A theme inking `panel-focus-border` / `panel-focus-shadow` / `panel-selected-bg` from its accent family is using the contract as intended — focus IS the load-bearing signal per focus region — but it must NOT also carry another accent fill in the panel region. One accent signal per region still holds.
2. **Focus chrome never touches high contrast.** The `prefers-contrast: more` and `forced-colors: active` recipes for `.terminal-selected` / `.terminal-selected-quiet` / `.terminal-focused` / `.assistant-focused` in `src/index.css` stay hardcoded to system colors and win over the extension keys — do not "unify" them into the extension surface.
3. **Grid gradients keep the audited flat layer.** `panel-grid-bg` / `terminal-grid-bg` accept full `background` shorthand, but the flat audited `surfaces.grid` hex must remain the gradient's final layer — it is the contrast/ramp source of truth, and the boot splash reads the flat `--theme-surface-grid` directly.
4. **`chrome-noise-texture` overrides are wholesale.** Any gradient string is legal and replaces the generated radial entirely; alpha lives inside the string. Review the composited result on the chrome surface, not the string.
5. **Welcome washes are whisper-alpha.** `welcome-field-wash` stays ≤8% effective alpha and every existing text alpha on the welcome screen must still clear its contrast floor over the composited wash — eyeball gate, since gradient strings defeat perceptibility regexes.
6. **Grain stays material.** `grain-opacity` ≤ 0.05; review `grainCharacter` textures composited on both polarities at 1x and 2x DPR (moiré check).

## File Map

| File | Purpose |
| --- | --- |
| `shared/theme/palette.ts` | `ThemePalette` and `ThemeStrategy` types |
| `shared/theme/types.ts` | `APP_THEME_TOKEN_KEYS`, `AppThemeTokenKey`, `AppColorScheme`, `EXTENSION_KEYS`, `ExtensionKey` |
| `shared/theme/extensionRegistry.ts` | Extension-key registry (`EXTENSION_KEY_REGISTRY`); OPTIONAL vs REQUIRED classification of component-override keys |
| `shared/theme/semantic.ts` | `createSemanticTokens()` — palette to tokens compiler |
| `shared/theme/themes.ts` | `createDaintreeTokens()`, `BUILT_IN_APP_SCHEMES`, `createThemeFromSource()` |
| `shared/theme/contrast.ts` | `getThemeContrastWarnings()` WCAG validation |
| `shared/theme/builtInThemeSources.ts` | `BuiltInThemeSource` interface + re-export |
| `shared/theme/builtInThemes/index.ts` | Theme manifest array |
| `shared/theme/builtInThemes/*.ts` | Individual built-in theme definitions |
| `shared/theme/terminal.ts` | Maps resolved app tokens to xterm `ITheme` |
| `shared/theme/entityColors.ts` | Panel brand colors, branch type Tailwind classes |
| `src/theme/applyAppTheme.ts` | DOM injection of CSS vars, CVD overrides |
| `shared/theme/colorVisionOverrides.ts` | CVD token tables (`RED_GREEN_OVERRIDES`, `BLUE_YELLOW_OVERRIDES`, `ALL_CVD_TOKENS`) |
| `src/index.css` | Tailwind v4 `@theme inline` mappings |
| `src/store/appThemeStore.ts` | Renderer theme state (Zustand) |
| `src/config/terminalColorSchemes.ts` | Terminal-specific color scheme library |
| `electron/utils/appThemeImporter.ts` | JSON import with normalization and validation |
| `src/styles/components/toolbar.css` | Toolbar component vars |
| `src/styles/components/sidebar.css` | Sidebar/worktree component vars |
| `src/styles/components/settings.css` | Settings dialog component vars |
| `src/styles/components/pulse.css` | Pulse component vars |
| `src/styles/components/panels.css` | Panel shell component vars |

# Theme System

Canopy's theming system is a three-layer pipeline shared between the renderer and main process:

1. `ThemePalette`
   Theme authors define the visual foundation in `shared/theme/palette.ts`: surfaces, text, accent, status, activity, terminal colors, syntax colors, and a small `strategy` object.
2. Semantic tokens
   `createSemanticTokens()` in `shared/theme/semantic.ts` compiles a palette into the stable app token contract (`AppColorSchemeTokens` in `shared/theme/types.ts`). Internally this calls `createCanopyTokens()` in `shared/theme/themes.ts` which derives ~100 tokens from ~40 required palette inputs.
3. Component public vars
   Individual UI areas expose their own override surface through CSS variables such as `--toolbar-bg`, `--toolbar-project-bg`, `--settings-dialog-bg`, `--pulse-card-bg`, and `--terminal-grid-bg`.

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
  extensions?: Record<string, string>; // component-level CSS variable overrides
  location?: string;
  heroImage?: string;
  heroVideo?: string;
}
```

## Semantic Tokens

Semantic tokens are app-wide values exposed as `--theme-*` CSS variables. The full token set is documented in [theme-tokens.md](./theme-tokens.md). Key groups:

- Surfaces: `surface-canvas`, `surface-sidebar`, `surface-toolbar`, `surface-panel`, `surface-panel-elevated`, `surface-grid`, `surface-input`, `surface-inset`, `surface-hover`, `surface-active`
- Text, border, accent (primary + optional secondary lane), status, activity
- Overlay ladder (tintable via `overlay-base`), atmospheric wash, scrim
- Shadow profiles (`shadow-ambient`, `shadow-floating`, `shadow-dialog`)
- Material/radius strategy outputs (`material-blur`, `material-saturation`, `material-opacity`, `radius-scale`)
- Terminal (first-class, independent of workbench), syntax highlighting
- GitHub states, search highlighting, diff viewer, category hues
- UI utility tokens: scrollbar, panel state edge, focus ring offset, chrome noise texture, state chip/label pill opacities

Component-specific styling does not belong in this layer.

## Component Overrides

Component CSS owns the public override surface. Themes can target specific UI regions through `extensions` without expanding the global semantic contract.

| Component          | File                                 | Variable prefix                                    |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Toolbar            | `src/styles/components/toolbar.css`  | `--toolbar-*`                                      |
| Sidebar / Worktree | `src/styles/components/sidebar.css`  | `--sidebar-*`, `--worktree-*`                      |
| Settings           | `src/styles/components/settings.css` | `--settings-*`                                     |
| Pulse              | `src/styles/components/pulse.css`    | `--pulse-*`                                        |
| Panel shell        | `src/styles/components/panels.css`   | `--chrome-*`, `--dialog-*`, `--floating-surface-*` |

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
- `applyColorVisionMode()` overrides 19 tokens for colorblind simulation ("red-green" and "blue-yellow" modes).
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

## File Map

| File                                  | Purpose                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `shared/theme/palette.ts`             | `ThemePalette` and `ThemeStrategy` types                                  |
| `shared/theme/types.ts`               | `APP_THEME_TOKEN_KEYS`, `AppThemeTokenKey`, `AppColorScheme`              |
| `shared/theme/semantic.ts`            | `createSemanticTokens()` — palette to tokens compiler                     |
| `shared/theme/themes.ts`              | `createCanopyTokens()`, `BUILT_IN_APP_SCHEMES`, `createThemeFromSource()` |
| `shared/theme/contrast.ts`            | `getThemeContrastWarnings()` WCAG validation                              |
| `shared/theme/builtInThemeSources.ts` | `BuiltInThemeSource` interface + re-export                                |
| `shared/theme/builtInThemes/index.ts` | Theme manifest array                                                      |
| `shared/theme/builtInThemes/*.ts`     | Individual built-in theme definitions                                     |
| `shared/theme/terminal.ts`            | Maps resolved app tokens to xterm `ITheme`                                |
| `shared/theme/entityColors.ts`        | Panel brand colors, branch type Tailwind classes                          |
| `src/theme/applyAppTheme.ts`          | DOM injection of CSS vars, CVD overrides                                  |
| `src/index.css`                       | Tailwind v4 `@theme inline` mappings                                      |
| `src/store/appThemeStore.ts`          | Renderer theme state (Zustand)                                            |
| `src/config/terminalColorSchemes.ts`  | Terminal-specific color scheme library                                    |
| `electron/utils/appThemeImporter.ts`  | JSON import with normalization and validation                             |
| `src/styles/components/toolbar.css`   | Toolbar component vars                                                    |
| `src/styles/components/sidebar.css`   | Sidebar/worktree component vars                                           |
| `src/styles/components/settings.css`  | Settings dialog component vars                                            |
| `src/styles/components/pulse.css`     | Pulse component vars                                                      |
| `src/styles/components/panels.css`    | Panel shell component vars                                                |

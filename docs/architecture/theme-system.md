# Theme System

Canopy's app theme system is a semantic-token pipeline shared between the renderer and main process.

## Core Model

- Theme definitions live in `shared/theme/`.
- `AppColorScheme` is the canonical theme object: `id`, `name`, `type`, `builtin`, and a complete `tokens` map.
- The public token contract is `APP_THEME_TOKEN_KEYS` in `shared/theme/types.ts`.
- Tokens are semantic, not component-specific. Examples: `surface-canvas`, `text-primary`, `accent-primary`, `status-danger`.

## Built-In and Fallback Themes

- User-visible built-in themes are declared in `shared/theme/themes.ts` as `BUILT_IN_APP_SCHEMES`.
- There is also an internal light fallback base in `shared/theme/themes.ts` used only for normalization and import.
- Partial custom light themes should inherit from that internal light fallback, not from the default dark theme.

## Normalization

- `normalizeAppColorScheme()` is the entry point for turning partial or imported theme data into a complete `AppColorScheme`.
- Missing tokens are filled from a base theme selected by `type`.
- If `type` is missing, the system tries to infer it from `surface-canvas` before falling back to dark.
- If a theme overrides `accent-primary` but omits `accent-foreground`, normalization chooses a readable foreground automatically.

## Runtime Application

- Renderer startup applies the default app theme in `src/main.tsx`.
- Theme injection happens through `applyAppThemeToRoot()` in `src/theme/applyAppTheme.ts`.
- `getAppThemeCssVariables()` converts semantic tokens into `--theme-*` CSS variables.
- Tailwind color aliases are defined in `src/index.css` and point at those CSS variables.

## CVD Overrides

- Color vision deficiency overrides are applied after the base theme.
- The override layer lives in `src/theme/applyAppTheme.ts`.
- This is app-enforced and should remain independent of custom theme author choices.

## Import Flow

- App theme import is handled by `electron/utils/appThemeImporter.ts`.
- Imported theme files must be JSON objects.
- The importer accepts nested `tokens` objects and also supports flat token maps for recognized theme keys.
- Unknown nested tokens are ignored and returned as warnings.
- Import warnings are non-blocking and currently cover:
  - inferred missing `type`
  - ignored unknown nested tokens
  - low-contrast critical token pairs

## Contrast Warnings

- `getAppThemeWarnings()` in `shared/theme/themes.ts` evaluates a small set of critical foreground/background pairs.
- Warnings are intentionally soft; they should guide theme authors without blocking import.
- The settings picker surfaces warning counts per theme and import-time warning messages.

## Renderer State

- Theme selection state is stored in `src/store/appThemeStore.ts`.
- Persisted config comes from the app theme IPC handlers in `electron/ipc/handlers/appTheme.ts`.
- Custom themes are stored as serialized JSON in the main-process store and normalized when loaded.

## Current Constraints

- The semantic token contract is the stable API. Avoid introducing component-level theme tokens.
- Spacing, layout, and animation timing remain app-owned.
- A user-facing light preset is intentionally not exposed yet; only the internal light fallback exists to support upcoming work safely.

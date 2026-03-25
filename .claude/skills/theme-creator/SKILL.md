---
name: theme-creator
description: Guide for creating or modifying Canopy themes. Use when working on theme palettes, semantic tokens, component extensions, or built-in theme definitions.
---

# Canopy Theme Creator

Before starting, read the architecture documentation for full context:

- `docs/themes/theme-system.md` — Three-layer pipeline, core model, component override pattern, runtime application, import flow
- `docs/themes/theme-tokens.md` — Complete token reference (142 tokens), authoring vs resolved contracts, derivation defaults, contrast rules

## Three-Layer Pipeline

Canopy themes flow through three layers. Each layer has a specific role:

1. **Palette** — The visual foundation. A structured object defining surfaces, text, accent, borders, status, activity, terminal, syntax, and strategy. This is what theme authors write.
2. **Semantic tokens** — Compiled from the palette by `createSemanticTokens()`. These become `--theme-*` CSS variables. ~140 tokens covering every app-wide visual concern.
3. **Component extensions** — Optional per-component CSS variable overrides for targeted styling (toolbar chrome, sidebar states, settings dialog, pulse cards, etc.).

## Key Files

| Purpose                  | Path                                  |
| ------------------------ | ------------------------------------- |
| Palette type definition  | `shared/theme/palette.ts`             |
| Semantic token compiler  | `shared/theme/semantic.ts`            |
| Token key contract       | `shared/theme/types.ts`               |
| Contrast validation      | `shared/theme/contrast.ts`            |
| Theme compilation        | `shared/theme/themes.ts`              |
| Built-in theme interface | `shared/theme/builtInThemeSources.ts` |
| Built-in theme index     | `shared/theme/builtInThemes/index.ts` |
| DOM application          | `src/theme/applyAppTheme.ts`          |
| CSS aliases & root vars  | `src/index.css` (lines 360-560)       |
| Theme system doc         | `docs/themes/theme-system.md`         |
| Token reference doc      | `docs/themes/theme-tokens.md`         |

### Component CSS (extension surfaces)

| Component          | File                                 | Variable prefix                                    |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Toolbar            | `src/styles/components/toolbar.css`  | `--toolbar-*`                                      |
| Sidebar / Worktree | `src/styles/components/sidebar.css`  | `--sidebar-*`, `--worktree-*`                      |
| Settings dialog    | `src/styles/components/settings.css` | `--settings-*`                                     |
| Project Pulse      | `src/styles/components/pulse.css`    | `--pulse-*`                                        |
| Panel chrome       | `src/styles/components/panels.css`   | `--chrome-*`, `--dialog-*`, `--floating-surface-*` |

## Palette Structure

A `ThemePalette` has these sections:

- **`type`**: `"dark"` or `"light"`
- **`surfaces`** (5 tiers, darkest to lightest for light themes, opposite for dark):
  - `grid` — Panel grid background, the structural base
  - `sidebar` — Left sidebar, toolbar surface
  - `canvas` — General content canvas
  - `panel` — Panel backgrounds, cards, dialogs
  - `elevated` — Tooltips, popovers, elevated cards
- **`text`**: `primary`, `secondary`, `muted`, `inverse`
- **`border`**: Single base border color
- **`accent`**: Primary accent color (optional `accentSecondary`)
- **`status`**: `success`, `warning`, `danger`, `info`
- **`activity`**: `active`, `idle`, `working`, `waiting`
- **`terminal`**: Full ANSI palette — `background`, `foreground`, `muted`, `cursor`, `selection`, 8 base colors, 8 bright variants
- **`syntax`**: `comment`, `punctuation`, `number`, `string`, `operator`, `keyword`, `function`, `link`, `quote`, `chip`
- **`strategy`** (optional):
  - `shadowStyle`: `"none"` | `"crisp"` | `"soft"` | `"atmospheric"`
  - `materialBlur`: backdrop blur in px (0 = disabled)
  - `materialSaturation`: backdrop saturation percentage
  - `radiusScale`: global border-radius multiplier
  - `noiseOpacity`: texture noise overlay opacity
  - `panelStateEdge`: colored edge indicator on panels

## Theme Source Interface

Built-in themes are authored as `BuiltInThemeSource`:

```typescript
{
  id: string;           // kebab-case identifier
  name: string;         // Display name
  type: "dark" | "light";
  builtin: true;
  palette: ThemePalette;
  tokens?: Partial<AppColorSchemeTokens>;  // Semantic token overrides
  extensions?: Record<string, string>;      // Component variable overrides
  location?: string;    // Geographic inspiration
  heroImage?: string;   // Theme preview image path
}
```

### When to use each layer

- **`palette`** — Always required. Defines the visual identity.
- **`tokens`** — Use sparingly to override specific semantic values that `createSemanticTokens()` doesn't derive well from the palette alone (e.g., fine-tuning overlay opacities, shadow composites, accent-muted values).
- **`extensions`** — Use for component-specific styling. These become bare CSS custom properties on `:root` (e.g., `"toolbar-project-bg": "..."` → `--toolbar-project-bg`).

## Component Extension Pattern

Component CSS files define fallback chains:

```css
.toolbar-project-pill {
  --_bg: var(--toolbar-project-bg, var(--theme-wash-medium));
  --_border: var(--toolbar-project-border, var(--theme-border-subtle));
}
```

The component checks for its own override first, then falls back to a semantic token. Themes that don't need custom component styling can omit extensions entirely — the fallbacks provide sensible defaults.

The grid background uses a similar pattern:

```css
--color-grid-bg: var(--panel-grid-bg, var(--terminal-grid-bg, var(--theme-surface-grid)));
```

So a theme can override just the grid area without changing the structural surface hierarchy.

## Contrast Requirements

Themes must pass WCAG 2.1 contrast checks. Use `getThemeContrastWarnings()` from `shared/theme/contrast.ts` to validate:

- **Text primary** on all 5 surface tiers: minimum **4.5:1**
- **Text secondary** on canvas/panel/elevated: minimum **3:1**
- **Accent foreground** on accent background: **4.5:1**
- **Terminal foreground** on terminal background: **4.5:1**
- **Terminal red/green** on terminal background: **3:1**

## Design Philosophy

Built-in themes are named after natural locations worldwide. Each theme evokes the colors, light, and atmosphere of its place:

- **Dark themes** use deep, rich surfaces with vibrant terminal palettes
- **Light themes** use airy, bright surfaces with enough contrast for readability
- The terminal palette is always independent from workbench surfaces — terminals are their own environment
- Shadows, material blur, and noise are atmospheric tools — use them to reinforce the theme's character
- Component extensions are for precision — use them to fine-tune specific UI regions without bloating the global token set

## Workflow for Creating a New Theme

1. Start with the palette — pick your 5 surface tiers, text colors, accent, and border
2. Run `createSemanticTokens()` mentally or in a test to see what it derives
3. Override any semantic tokens that don't look right via `tokens`
4. Add component extensions only where needed for polish
5. Validate contrast with `getThemeContrastWarnings()`
6. Add the theme file to `shared/theme/builtInThemes/` and register in `index.ts`

## Workflow for Modifying an Existing Theme

1. Read the theme's source file in `shared/theme/builtInThemes/`
2. Understand the palette hierarchy — surfaces go from structural (grid) to elevated
3. Make palette changes first; they cascade through semantic token derivation
4. Adjust `tokens` overrides only if the derived values aren't right
5. Adjust `extensions` for component-specific refinements
6. Check contrast after changes — lightening surfaces can break text contrast

$ARGUMENTS

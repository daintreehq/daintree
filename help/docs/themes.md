# Themes

## Overview

Canopy has a rich theme system designed for long coding sessions. Themes affect the entire application — surfaces, text, accents, terminal colors, and syntax highlighting — providing a cohesive visual experience.

## Built-In Themes

Canopy ships with 14 built-in themes, named after natural places:

### Dark Themes

| Theme          | Character                    |
| -------------- | ---------------------------- |
| **Daintree**   | Deep forest greens           |
| **Arashiyama** | Bamboo-inspired warm tones   |
| **Fiordland**  | Cool, misty blues            |
| **Galapagos**  | Ocean-inspired deep teals    |
| **Highlands**  | Earthy, muted tones          |
| **Namib**      | Desert-inspired warm palette |
| **Redwoods**   | Rich, warm browns and reds   |

### Light Themes

| Theme              | Character               |
| ------------------ | ----------------------- |
| **Bondi**          | Bright coastal blues    |
| **Table Mountain** | Clean, airy neutrals    |
| **Atacama**        | Warm desert light       |
| **Bali**           | Tropical green accents  |
| **Hokkaido**       | Crisp, cool whites      |
| **Serengeti**      | Warm savanna tones      |
| **Svalbard**       | Arctic whites and blues |

## Changing Themes

Open Settings (Cmd+,) and navigate to the theme section. You can:

- Browse all themes with previews
- Switch between dark and light themes
- Use the random theme cycler to discover themes you haven't tried

## Theme Structure

Each theme defines:

- **Surfaces** — Background colors for canvas, sidebar, toolbar, panels, grid, inputs
- **Text and borders** — Foreground colors at different emphasis levels
- **Accent colors** — Primary brand color used for selections, links, focus rings
- **Status colors** — Success, warning, error, info indicators
- **Activity colors** — Agent state indicators (working, waiting, idle, completed)
- **Terminal colors** — Full 16-color ANSI palette for terminal output
- **Syntax colors** — Code highlighting in the file viewer

## Custom Themes

Canopy supports custom themes that follow the same palette structure as built-in themes. Custom themes can override any semantic token or component-specific CSS variable.

## Accessibility

Themes are designed with accessibility in mind:

- Both dark and light variants are available for different lighting conditions and preferences
- Color contrast ratios are maintained across themes
- The theme system supports high-contrast overrides

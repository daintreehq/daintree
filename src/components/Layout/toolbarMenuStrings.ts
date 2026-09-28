import { PanelTop, type LucideIcon } from "lucide-react";

// Single-source constants for the toolbar right-click context menu entries
// (issue #9825). The "Customize" entry uses the U+2026 ellipsis to signal
// "opens a dialog" — same convention as `confirm`-tier action items
// (`src/components/ActionPalette/ActionPaletteItem.tsx:126`).
export const TOOLBAR_UNPIN_LABEL = "Unpin from toolbar";
export const TOOLBAR_PIN_LABEL = "Pin to toolbar";
export const TOOLBAR_CUSTOMIZE_LABEL = "Customize toolbar…";

// Customize toolbar opens the Toolbar settings tab, so it carries that tab's
// glyph — the strip along the top of the window. Not a gear: Settings2 is
// Manage presets / Manage agents, the row beside it in the agent and launcher
// menus, and two neighbouring gears read as one destination listed twice.
export const TOOLBAR_CUSTOMIZE_ICON: LucideIcon = PanelTop;

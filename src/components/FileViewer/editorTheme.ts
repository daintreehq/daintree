import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";

export const daintreeThemeSettings = {
  background: "var(--theme-surface-canvas)",
  foreground: "var(--theme-text-primary)",
  caret: "var(--theme-accent-primary)",
  selection: "var(--theme-terminal-selection)",
  selectionMatch: "var(--theme-terminal-selection)",
  lineHighlight: "var(--theme-border-default)",
  gutterBackground: "var(--theme-surface-canvas)",
  gutterForeground: "var(--theme-activity-idle)",
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
} as const;

export const daintreeThemeStyles = [
  { tag: t.heading, color: "var(--theme-syntax-keyword)", fontWeight: "bold" },
  { tag: t.heading1, color: "var(--theme-syntax-keyword)", fontWeight: "bold", fontSize: "1.4em" },
  { tag: t.heading2, color: "var(--theme-syntax-keyword)", fontWeight: "bold", fontSize: "1.2em" },
  { tag: t.heading3, color: "var(--theme-syntax-keyword)", fontWeight: "bold", fontSize: "1.1em" },
  { tag: t.keyword, color: "var(--theme-syntax-keyword)" },
  // Comments paint with the dedicated syntax-comment role so they're validated
  // against the canvas they render on (RC-8) — not activity-idle, which is a
  // chrome signal tuned for the dark terminal, not editor legibility on a light
  // canvas.
  { tag: t.comment, color: "var(--theme-syntax-comment)" },
  { tag: t.string, color: "var(--theme-syntax-string)" },
  { tag: t.url, color: "var(--theme-syntax-link)", textDecoration: "underline" },
  { tag: t.quote, color: "var(--theme-syntax-quote)", fontStyle: "italic" },
  { tag: t.link, color: "var(--theme-syntax-link)" },
];

export type EditorThemePolarity = "dark" | "light";

/**
 * Build the CodeMirror theme for the active app scheme. The `theme` flag drives
 * CodeMirror's internal default base (selection layering, default token
 * fallbacks), so it MUST track the active palette's polarity — hardcoding
 * "dark" left CodeMirror compositing its dark defaults under a near-white
 * canvas on every light theme (RC-8). Surfaces are still painted from the
 * theme CSS vars in `daintreeThemeSettings`, which is the render surface
 * (surface-canvas) the syntax roles are validated against.
 */
export function createDaintreeEditorTheme(polarity: EditorThemePolarity) {
  return createTheme({
    theme: polarity,
    settings: daintreeThemeSettings,
    styles: daintreeThemeStyles,
  });
}

const themeByPolarity: Record<EditorThemePolarity, ReturnType<typeof createDaintreeEditorTheme>> = {
  dark: createDaintreeEditorTheme("dark"),
  light: createDaintreeEditorTheme("light"),
};

/** Memoized accessor — returns the prebuilt CodeMirror theme for a polarity. */
export function getDaintreeEditorTheme(polarity: EditorThemePolarity) {
  return themeByPolarity[polarity];
}

/** @deprecated Use `getDaintreeEditorTheme(scheme.type)` so light palettes get a light base. */
export const daintreeTheme = themeByPolarity.dark;

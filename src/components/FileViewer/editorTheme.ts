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
  // h4-h6 stay bold at body size: the size ramp stops at h3 so deep headings
  // read as structure without turning the source into a poster (#12323).
  {
    tag: [t.heading4, t.heading5, t.heading6],
    color: "var(--theme-syntax-keyword)",
    fontWeight: "bold",
  },
  { tag: t.keyword, color: "var(--theme-syntax-keyword)" },
  // Markdown inline structure (#12323). Emphasis and strong are typographic,
  // not coloured: the text stays body text so a paragraph full of *italics*
  // doesn't light up. Inline code shares the string role, matching the
  // rendered document's code styling. Thematic breaks take the punctuation
  // role. `t.list` is deliberately absent — lezer-markdown tags the whole
  // list-item subtree with it, so any colour would wash every list; the
  // markers themselves arrive as processingInstruction below.
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, color: "var(--theme-syntax-string)" },
  { tag: t.contentSeparator, color: "var(--theme-syntax-punctuation)" },
  // The markup characters themselves (`#`, `**`, `>`, `[]()`, fence ticks,
  // table pipes) read as scaffolding rather than text: the comment role is the
  // one syntax colour every theme already tunes for "present but secondary".
  { tag: [t.processingInstruction, t.meta], color: "var(--theme-syntax-comment)" },
  // Comments paint with the dedicated syntax-comment role so they're validated
  // against the canvas they render on (RC-8) — not activity-idle, which is a
  // chrome signal tuned for the dark terminal, not editor legibility on a light
  // canvas.
  { tag: t.comment, color: "var(--theme-syntax-comment)" },
  { tag: t.string, color: "var(--theme-syntax-string)" },
  { tag: t.url, color: "var(--theme-syntax-link)", textDecoration: "underline" },
  { tag: t.quote, color: "var(--theme-syntax-quote)", fontStyle: "italic" },
  { tag: t.link, color: "var(--theme-syntax-link)" },
  // D1b: previously only ~7 tags were mapped — number/function/operator/
  // punctuation/type/property fell through to text-primary, collapsing to a
  // near-monochrome render on the light canvas (everything but keyword/string/
  // comment painted in body text). Map them onto the existing syntax roles,
  // mirroring the highlight.js role assignments used for the markdown renderer
  // (src/index.css:493-562) so the editor and prose share one vocabulary. No
  // dedicated syntax-type / syntax-property roles exist, so type folds into the
  // keyword role and property into the number role, matching the hljs mapping
  // (.hljs-type -> keyword, .hljs-attr -> number). All roles are still painted
  // from the theme CSS vars and validated against surface-canvas (RC-8).
  { tag: [t.number, t.literal, t.bool], color: "var(--theme-syntax-number)" },
  { tag: t.operator, color: "var(--theme-syntax-operator)" },
  { tag: t.punctuation, color: "var(--theme-syntax-punctuation)" },
  { tag: [t.typeName, t.className], color: "var(--theme-syntax-keyword)" },
  { tag: t.propertyName, color: "var(--theme-syntax-number)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: "var(--theme-syntax-function)",
  },
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

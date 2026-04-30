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
  { tag: t.comment, color: "var(--theme-activity-idle)" },
  { tag: t.string, color: "var(--theme-syntax-string)" },
  { tag: t.url, color: "var(--theme-syntax-link)", textDecoration: "underline" },
  { tag: t.quote, color: "var(--theme-syntax-quote)", fontStyle: "italic" },
  { tag: t.link, color: "var(--theme-syntax-link)" },
];

export const daintreeTheme = createTheme({
  theme: "dark",
  settings: daintreeThemeSettings,
  styles: daintreeThemeStyles,
});

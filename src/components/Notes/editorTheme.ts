import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";

export const daintreeTheme = createTheme({
  theme: "dark",
  settings: {
    background: "var(--theme-surface-canvas)",
    foreground: "var(--theme-text-primary)",
    caret: "var(--theme-accent-primary)",
    selection: "var(--theme-terminal-selection)",
    selectionMatch: "var(--theme-terminal-selection)",
    lineHighlight: "var(--theme-border-default)",
    gutterBackground: "var(--theme-surface-canvas)",
    gutterForeground: "var(--theme-activity-idle)",
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  },
  styles: [
    { tag: t.heading, color: "var(--theme-accent-primary)", fontWeight: "bold" },
    { tag: t.heading1, fontSize: "1.4em" },
    { tag: t.heading2, fontSize: "1.2em" },
    { tag: t.heading3, fontSize: "1.1em" },
    { tag: t.keyword, color: "var(--theme-syntax-keyword)" },
    { tag: t.comment, color: "var(--theme-activity-idle)" },
    { tag: t.string, color: "var(--theme-syntax-string)" },
    { tag: t.url, color: "var(--theme-syntax-link)", textDecoration: "underline" },
    { tag: t.quote, color: "var(--theme-syntax-quote)", fontStyle: "italic" },
    { tag: t.link, color: "var(--theme-syntax-link)" },
    { tag: t.list, color: "var(--theme-accent-primary)" },
  ],
});

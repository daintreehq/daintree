import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

export const canopyTheme = createTheme({
  theme: "dark",
  settings: {
    background: "var(--color-canopy-bg)",
    foreground: "var(--color-canopy-text)",
    caret: "var(--color-canopy-accent)",
    selection: "var(--color-terminal-selection)",
    selectionMatch: "var(--color-terminal-selection)",
    lineHighlight: "var(--color-canopy-border)",
    gutterBackground: "var(--color-canopy-bg)",
    gutterForeground: "var(--color-state-idle)",
  },
  styles: [
    { tag: t.heading, color: "var(--color-canopy-accent)", fontWeight: "bold" },
    { tag: t.heading1, fontSize: "1.4em" },
    { tag: t.heading2, fontSize: "1.2em" },
    { tag: t.heading3, fontSize: "1.1em" },
    { tag: t.keyword, color: "#a855f7" },
    { tag: t.comment, color: "var(--color-state-idle)" },
    { tag: t.string, color: "#f59e0b" },
    { tag: t.url, color: "#38bdf8", textDecoration: "underline" },
    { tag: t.quote, color: "#a1a1aa", fontStyle: "italic" },
    { tag: t.link, color: "#38bdf8" },
    { tag: t.list, color: "var(--color-canopy-accent)" },
  ],
});

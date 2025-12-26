import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

export const canopyTheme = createTheme({
  theme: "dark",
  settings: {
    background: "#18181b",
    foreground: "#e4e4e7",
    caret: "#10b981",
    selection: "#064e3b",
    selectionMatch: "#064e3b",
    lineHighlight: "#27272a",
    gutterBackground: "#18181b",
    gutterForeground: "#52525b",
  },
  styles: [
    { tag: t.heading, color: "#10b981", fontWeight: "bold" },
    { tag: t.heading1, fontSize: "1.4em" },
    { tag: t.heading2, fontSize: "1.2em" },
    { tag: t.heading3, fontSize: "1.1em" },
    { tag: t.keyword, color: "#a855f7" },
    { tag: t.comment, color: "#52525b" },
    { tag: t.string, color: "#f59e0b" },
    { tag: t.url, color: "#38bdf8", textDecoration: "underline" },
    { tag: t.quote, color: "#a1a1aa", fontStyle: "italic" },
    { tag: t.link, color: "#38bdf8" },
    { tag: t.list, color: "#10b981" },
  ],
});

import { EditorView } from "@codemirror/view";

export const editorSearchHighlightTheme = EditorView.theme({
  ".cm-searchMatch": {
    backgroundColor: "var(--color-search-highlight-background)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--color-search-highlight-background)",
    borderBottom: "2px solid var(--color-search-selected-result-border)",
  },
});

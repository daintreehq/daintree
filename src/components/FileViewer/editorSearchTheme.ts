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

// CodeMirror's search panel and go-to-line dialog, painted from the theme
// tokens. Shared by the read-only viewer and the Markdown editor (#12323) so
// the two find bars are the same find bar.
export const editorSearchPanelTheme = EditorView.theme({
  ".cm-panels": {
    backgroundColor: "var(--theme-surface-sidebar)",
    color: "var(--theme-text-primary)",
    borderBottom: "1px solid var(--theme-border-default)",
  },
  // The right inset clears the absolutely placed close button, so a field
  // shrunk to a narrow pane never runs under it.
  ".cm-panel.cm-search": {
    padding: "4px 24px 4px 8px",
  },
  // The query is the app's search field (`editorSearchPanel.ts`) and brings its
  // own paint from search-field.css; this only seats it in the panel's row.
  ".cm-search .search-field": {
    display: "inline-flex",
    verticalAlign: "middle",
    width: "16rem",
    maxWidth: "100%",
    margin: ".2em .6em .2em 0",
  },
  // Beats @codemirror/search's `.cm-panel.cm-search input` margin, which would
  // push the text off-centre inside the field.
  ".cm-panel.cm-search input.search-field-input": {
    margin: "0",
  },
  // Replacement text keeps the form-control treatment.
  ".cm-search .cm-textfield": {
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-default)",
    borderRadius: "var(--radius-xs)",
    outline: "none",
  },
  ".cm-search .cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-default)",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-search .cm-button:hover": {
    backgroundColor: "var(--theme-border-default)",
  },
  ".cm-search label": {
    color: "var(--theme-text-primary)",
  },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--theme-text-primary)",
  },
  ".cm-dialog": {
    backgroundColor: "var(--theme-surface-sidebar)",
    color: "var(--theme-text-primary)",
    borderBottom: "1px solid var(--theme-border-default)",
    padding: "4px 8px",
  },
  ".cm-dialog .cm-textfield": {
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-default)",
    borderRadius: "var(--radius-xs)",
    outline: "none",
  },
});

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
  // The right inset clears the absolutely placed close button, so a row that
  // wraps in a narrow pane never runs under it.
  ".cm-panel.cm-search": {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "4px 38px 4px 8px",
  },
  // Query, options, then the count and stepping, in the other find bars'
  // order. In a narrow pane the count and stepping wrap below as one group.
  ".cm-search .cm-search-row": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "8px",
    rowGap: "4px",
  },
  ".cm-search .cm-search-options, .cm-search .cm-search-results": {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  // Beats @codemirror/search's `.cm-panel.cm-search input, button` margin.
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    margin: "0",
  },
  // The query is the app's search field (`editorSearchPanel.ts`) and brings its
  // own paint from search-field.css; the replacement shares its column.
  ".cm-search .search-field, .cm-search .cm-textfield": {
    flex: "0 1 16rem",
    minWidth: "8rem",
  },
  ".cm-panel.cm-search .cm-search-close": {
    position: "absolute",
    top: "5px",
    right: "6px",
  },
  // Queries and replacements are code, so their values keep the editor's face.
  ".cm-panel.cm-search input.search-field-input, .cm-search .cm-textfield": {
    fontFamily: "var(--font-mono)",
  },
  // Replacement text keeps the form-control treatment, at the query's height
  // and corner so the two fields stack as one column. With no icon its edge is
  // the only boundary it has, so it takes the input border, not the hairline.
  ".cm-search .cm-textfield": {
    boxSizing: "border-box",
    height: "1.75rem",
    padding: "0 0.5rem",
    fontSize: "var(--text-xs)",
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-input)",
    borderRadius: "var(--radius-md)",
    outline: "none",
  },
  // The placeholder is the field's visible label, as in search-field.css.
  ".cm-search .cm-textfield::placeholder": {
    color: "var(--theme-text-secondary)",
  },
  // The outline's replacement: the find field's own focus treatment
  // (search-field.css), a neutral edge rather than a second accent.
  ".cm-search .cm-textfield:focus-visible, .cm-dialog .cm-textfield:focus-visible": {
    borderColor: "var(--theme-selection-outline)",
    boxShadow: "inset 0 0 0 1px var(--theme-selection-outline)",
  },
  // While find is open its matches are the only marks in the document: the
  // editors that highlight other occurrences of the selection would otherwise
  // keep painting the last match's word after a miss, which reads as hits.
  "&:has(.cm-panel.cm-search) .cm-selectionMatch": {
    backgroundColor: "transparent",
  },
  // A selection that isn't the current match while find has focus (a step,
  // then a miss or a new query) is where the user was, not a hit: a hairline,
  // where a fill would read as a match. An outline, so forced colours keep it.
  "&[data-find-off-match] .cm-selectionLayer .cm-selectionBackground": {
    background: "transparent !important",
    outline: "1px solid var(--theme-border-strong)",
    outlineOffset: "-1px",
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

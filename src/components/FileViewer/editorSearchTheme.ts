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
  // The chrome speaks in the app's UI face at the toolbar's size, not the
  // editor's code face at CodeMirror's 70-80%. The right inset reserves the
  // close button's column, so a row squeezed by a narrow pane never runs under it.
  ".cm-panel.cm-search": {
    display: "flex",
    flexDirection: "column",
    gap: ".25rem",
    padding: ".25rem 2.5rem .25rem .5rem",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
  },
  // @codemirror/search spaces every control with its own margin (and the
  // field's would push its text off-centre); the rows use gaps instead.
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    margin: "0",
  },
  // A row wraps a group at a time: navigation, then the options. The query
  // field gives up width first, 16rem down to 8.5rem, so the options only drop
  // to a second line once the field can't make room — no sooner than the
  // fixed-width row did with CodeMirror's shorter words (686px).
  ".cm-search-row": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: ".625rem",
    rowGap: ".25rem",
  },
  ".cm-search-group": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: ".125rem",
  },
  ".cm-search-options": {
    columnGap: ".625rem",
  },
  // The query is the app's search field (`editorSearchPanel.ts`) and brings its
  // own paint from search-field.css; this only seats it in the row.
  ".cm-search .search-field": {
    flex: "1 1 8.5rem",
    maxWidth: "16rem",
    minWidth: "0",
  },
  // Queries and replacements are code, so their values keep the editor's face.
  ".cm-panel.cm-search input.search-field-input, .cm-search .cm-textfield": {
    fontFamily: "var(--font-mono)",
  },
  // Replacement text keeps the form-control treatment, at the query field's
  // width (`editorSearchPanel.ts` hands it over) so the two stack as one
  // column. With no icon its edge is the only boundary it has, so it takes the
  // input border, not the hairline.
  ".cm-search .cm-textfield": {
    flex: "0 1 var(--cm-search-field-width, 16rem)",
    maxWidth: "16rem",
    minWidth: "0",
    height: "1.75rem",
    padding: "0 .5rem",
    fontSize: "var(--text-xs)",
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-input)",
    borderRadius: "var(--radius-xs)",
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
  // An option is its box and its word on one centre line at the toolbar text
  // button's height, so the row keeps one baseline; the box sits nearer its own
  // word than the next option's. Secondary ink at rest like the buttons,
  // stepping up to primary once switched on, as a pressed toolbar button's
  // does: the box and the word carry the state together. Spelled with
  // `.cm-panel` to outweigh @codemirror/search's 80% label size.
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: ".25rem",
    height: "1.625rem",
    fontSize: "var(--text-xs)",
    color: "var(--theme-text-secondary)",
    whiteSpace: "nowrap",
  },
  ".cm-panel.cm-search label:has(input:checked)": {
    color: "var(--theme-text-primary)",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    margin: "0",
    flexShrink: "0",
  },
  // A 1.5rem target centred on the find row's 1.75rem field, inset to the pane
  // header's close column, with the panel's right inset keeping a gap beside it. @codemirror/search pins `background-color: inherit`
  // here at a weight the toolbar button's hover can't beat, so the wash is
  // restated from the same tokens; the glyph keeps the editor's face.
  ".cm-panel.cm-search [name=close]": {
    top: ".375rem",
    right: ".75rem",
    width: "1.5rem",
    height: "1.5rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: "var(--theme-text-secondary)",
    backgroundColor: "transparent",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "1",
  },
  ".cm-panel.cm-search [name=close]:hover": {
    backgroundColor: "var(--toolbar-control-hover-bg, var(--theme-overlay-elevated))",
  },
  ".cm-panel.cm-search [name=close]:active": {
    backgroundColor: "var(--toolbar-control-active-bg, var(--theme-overlay-emphasis))",
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

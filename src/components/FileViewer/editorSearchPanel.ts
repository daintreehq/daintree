import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { PANE_TOOLBAR_TEXT_BUTTON_CLASS } from "@/components/ui/paneToolbarStyles";

// lucide `Search`, drawn by hand: this DOM belongs to CodeMirror, which mounts
// and focuses the panel synchronously, so there is no React root to render into.
const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  children: Node[] = []
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function searchIcon(): SVGSVGElement {
  return svg(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      class: "search-field-icon",
      "aria-hidden": "true",
    },
    [svg("circle", { cx: "11", cy: "11", r: "8" }), svg("path", { d: "m21 21-4.34-4.34" })]
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/**
 * CodeMirror's find panel with the query drawn as the app's search field
 * (`search-field.css`, the same control `SearchField` renders). Behaviour is
 * @codemirror/search's own `SearchPanel`: the same query sync, options,
 * shortcuts, `main-field` focus contract and read-only replace gating.
 */
class EditorSearchPanel implements Panel {
  readonly dom: HTMLElement;
  // Both editors mount `search({ top: true })`; the factory cannot read the
  // private config facet, so the placement is restated here.
  readonly top = true;
  private query: SearchQuery;
  private readonly field: HTMLDivElement;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  /** The replace row: in the panel exactly while the editor is editable. */
  private readonly replaceRow: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly caseField: HTMLInputElement;
  private readonly reField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;
  private readonly fieldWidth: ResizeObserver | null = null;

  constructor(private readonly view: EditorView) {
    const query = (this.query = getSearchQuery(view.state));
    const commit = () => this.commit();

    // The panel is Daintree's, so its words are too, not CodeMirror's phrase
    // keys. Visible words stay short so the row fits a split pane; where the
    // terminal and Browser find bars name a control with more words, the name
    // here extends the visible word to match, keeping it whole (WCAG 2.5.3).
    this.searchField = el("input", {
      type: "text",
      class: "search-field-input",
      name: "search",
      form: "",
      "main-field": "true",
      placeholder: "Find",
      "aria-label": "Find",
      spellcheck: "false",
      autocomplete: "off",
    });
    this.field = el("div", { class: "search-field", "data-size": "compact" }, [
      searchIcon(),
      this.searchField,
    ]);
    // The whole field is the pointer target, as in `SearchField`.
    this.field.addEventListener("pointerdown", (event) => {
      if (event.target === this.searchField) return;
      event.preventDefault();
      this.searchField.focus();
    });

    this.replaceField = el("input", {
      class: "cm-textfield",
      name: "replace",
      form: "",
      placeholder: "Replace",
      // Not "Replace": the button beside it is, and a voice command would hit both.
      "aria-label": "Replace with",
      spellcheck: "false",
      autocomplete: "off",
    });
    this.caseField = el("input", { type: "checkbox", name: "case", form: "" });
    this.wordField = el("input", {
      type: "checkbox",
      name: "word",
      form: "",
      "aria-label": "Match whole word",
    });
    // The sibling bars' "Use regular expression" doesn't contain "Regex", so
    // the visible word is the name.
    this.reField = el("input", { type: "checkbox", name: "re", form: "" });

    for (const input of [this.searchField, this.replaceField]) {
      // `input` also catches a mouse paste, which fires no keyup.
      input.addEventListener("input", commit);
      input.addEventListener("change", commit);
      input.addEventListener("keyup", commit);
    }
    for (const box of [this.caseField, this.reField, this.wordField]) {
      box.addEventListener("change", commit);
    }

    // The pane toolbar's text button, the control every in-pane toolbar uses
    // for a word, so the bar's actions look and respond like the toolbar above it.
    const button = (
      name: string,
      run: (view: EditorView) => boolean,
      label: string,
      {
        name: accessibleName,
        keepFieldFocus = false,
      }: { name?: string; keepFieldFocus?: boolean } = {}
    ) => {
      const attrs: Record<string, string> = {
        class: PANE_TOOLBAR_TEXT_BUTTON_CLASS,
        name,
        type: "button",
      };
      if (accessibleName) attrs["aria-label"] = accessibleName;
      const node = el("button", attrs, [label]);
      // Stepping leaves focus in the query, as Enter does and as the sibling
      // find bars' previous and next buttons do.
      if (keepFieldFocus) node.addEventListener("mousedown", (event) => event.preventDefault());
      node.addEventListener("click", () => run(view));
      return node;
    };
    const option = (box: HTMLInputElement, label: string) => el("label", {}, [box, label]);
    const group = (className: string, children: Node[]) =>
      el("div", { class: className }, children);

    const close = el(
      "button",
      {
        name: "close",
        type: "button",
        class: "toolbar-icon-button",
        "aria-label": "Close find bar",
      },
      [el("span", { "aria-hidden": "true" }, ["×"])]
    );
    close.addEventListener("click", () => closeSearchPanel(view));
    this.closeButton = close;
    this.replaceRow = group("cm-search-row", [
      this.replaceField,
      group("cm-search-group", [
        button("replace", replaceNext, "Replace"),
        button("replaceAll", replaceAll, "Replace all"),
      ]),
    ]);

    this.dom = el("div", { class: "cm-search" }, [
      group("cm-search-row", [
        this.field,
        group("cm-search-group", [
          button("prev", findPrevious, "Previous", {
            name: "Previous match",
            keepFieldFocus: true,
          }),
          button("next", findNext, "Next", { name: "Next match", keepFieldFocus: true }),
          button("select", selectMatches, "Select all matches"),
        ]),
        group("cm-search-group cm-search-options", [
          option(this.caseField, "Match case"),
          option(this.wordField, "Whole word"),
          option(this.reField, "Regex"),
        ]),
      ]),
      ...(view.state.readOnly ? [] : [this.replaceRow]),
      close,
    ]);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));

    // The query field gives up width to keep its row whole, and flex sizes each
    // row's field against different neighbours, so the replacement field is
    // handed the query field's width to keep the two in one column.
    if (typeof ResizeObserver !== "undefined") {
      this.fieldWidth = new ResizeObserver(([entry]) => {
        const width = entry?.borderBoxSize[0]?.inlineSize;
        if (width) this.dom.style.setProperty("--cm-search-field-width", `${width}px`);
      });
      this.fieldWidth.observe(this.field);
    }

    this.setQuery(query);
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
      literal: this.query.literal,
      test: this.query.test,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.markValidity();
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private keydown(event: KeyboardEvent): void {
    // Keys that belong to an IME (committing a candidate, cancelling it) are
    // neither a search nor a panel shortcut. Chromium can report the
    // boundary keystroke with `isComposing` already false but keyCode 229.
    if (event.isComposing || event.keyCode === 229) return;
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  update(update: ViewUpdate): void {
    // An editor that turns read-only (or editable) while find is open keeps
    // the panel, so the replace row follows it here, as it would on reopen.
    if (update.startState.readOnly !== update.state.readOnly) {
      if (update.state.readOnly) {
        if (this.replaceRow.contains(document.activeElement)) this.searchField.focus();
        this.replaceRow.remove();
      } else {
        this.dom.insertBefore(this.replaceRow, this.closeButton);
      }
    }
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        // Identity, not `eq()`: `eq()` ignores `literal`, and the panel's own
        // commits come back as the very object it dispatched.
        if (effect.is(setSearchQuery) && effect.value !== this.query) this.setQuery(effect.value);
      }
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseField.checked = query.caseSensitive;
    this.reField.checked = query.regexp;
    this.wordField.checked = query.wholeWord;
    this.markValidity();
  }

  // An empty query is not a broken one; only a pattern that fails to compile is.
  private markValidity(): void {
    const invalid = this.query.search !== "" && !this.query.valid;
    if (invalid) {
      this.field.setAttribute("data-invalid", "true");
      this.searchField.setAttribute("aria-invalid", "true");
    } else {
      this.field.removeAttribute("data-invalid");
      this.searchField.removeAttribute("aria-invalid");
    }
  }

  destroy(): void {
    this.fieldWidth?.disconnect();
  }

  mount(): void {
    // Chromium's select() focuses as a side effect; the open-focus contract
    // should not rest on that.
    this.searchField.focus();
    this.searchField.select();
  }
}

/** `search({ top: true, createPanel: createEditorSearchPanel })`. */
export function createEditorSearchPanel(view: EditorView): Panel {
  return new EditorSearchPanel(view);
}

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
  private readonly caseField: HTMLInputElement;
  private readonly reField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;

  constructor(private readonly view: EditorView) {
    const query = (this.query = getSearchQuery(view.state));
    const phrase = (text: string) => view.state.phrase(text);
    const commit = () => this.commit();

    this.searchField = el("input", {
      type: "text",
      class: "search-field-input",
      name: "search",
      form: "",
      "main-field": "true",
      placeholder: phrase("Find"),
      "aria-label": phrase("Find"),
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
      placeholder: phrase("Replace"),
      "aria-label": phrase("Replace"),
    });
    this.caseField = el("input", { type: "checkbox", name: "case", form: "" });
    this.reField = el("input", { type: "checkbox", name: "re", form: "" });
    this.wordField = el("input", { type: "checkbox", name: "word", form: "" });

    for (const input of [this.searchField, this.replaceField]) {
      // `input` also catches a mouse paste, which fires no keyup.
      input.addEventListener("input", commit);
      input.addEventListener("change", commit);
      input.addEventListener("keyup", commit);
    }
    for (const box of [this.caseField, this.reField, this.wordField]) {
      box.addEventListener("change", commit);
    }

    const button = (name: string, run: (view: EditorView) => boolean, label: string) => {
      const node = el("button", { class: "cm-button", name, type: "button" }, [phrase(label)]);
      node.addEventListener("click", () => run(view));
      return node;
    };
    const close = el("button", { name: "close", type: "button", "aria-label": phrase("close") }, [
      "×",
    ]);
    close.addEventListener("click", () => closeSearchPanel(view));

    this.dom = el("div", { class: "cm-search" }, [
      this.field,
      button("next", findNext, "next"),
      button("prev", findPrevious, "previous"),
      button("select", selectMatches, "all"),
      el("label", {}, [this.caseField, phrase("match case")]),
      el("label", {}, [this.reField, phrase("regexp")]),
      el("label", {}, [this.wordField, phrase("by word")]),
      ...(view.state.readOnly
        ? []
        : [
            el("br", {}),
            this.replaceField,
            button("replace", replaceNext, "replace"),
            button("replaceAll", replaceAll, "replace all"),
          ]),
      close,
    ]);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));

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
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    // An Enter that commits an IME candidate is not a search.
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.target === this.searchField) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      replaceNext(this.view);
    }
  }

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        // Identity, not `eq()`: `eq()` ignores `literal` and `test`, and the
        // panel's own commits come back as the very object it dispatched.
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

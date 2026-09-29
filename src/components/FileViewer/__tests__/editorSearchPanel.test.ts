// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  SearchQuery,
  getSearchQuery,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { createEditorSearchPanel } from "../editorSearchPanel";

function mount(doc: string, { readOnly }: { readOnly: boolean }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        search({ top: true, createPanel: createEditorSearchPanel }),
        keymap.of(searchKeymap),
        EditorState.readOnly.of(readOnly),
        // CodeViewer gets this from basicSetup, and the "all" button needs it.
        EditorState.allowMultipleSelections.of(true),
      ],
    }),
    parent: host,
  });
  openSearchPanel(view);
  return { view, host };
}

function panel(): HTMLElement {
  const dom = document.querySelector<HTMLElement>(".cm-panel.cm-search");
  if (!dom) throw new Error("search panel is not open");
  return dom;
}

function queryInput(): HTMLInputElement {
  return panel().querySelector<HTMLInputElement>("input[name=search]")!;
}

function field(name: string): HTMLInputElement {
  return panel().querySelector<HTMLInputElement>(`input[name=${name}]`)!;
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

// CodeMirror resolves `Mod` from the platform it saw at import time.
function modKey(): KeyboardEventInit {
  return /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
}

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
  mounted?.view.destroy();
  mounted?.host.remove();
  mounted = null;
});

describe("editorSearchPanel (#12755)", () => {
  it("draws the query as the app's search field, focused and carrying CodeMirror's main-field", () => {
    mounted = mount("alpha", { readOnly: true });
    const input = queryInput();
    const wrapper = input.parentElement!;
    expect(wrapper.classList.contains("search-field")).toBe(true);
    expect(wrapper.getAttribute("data-size")).toBe("compact");
    expect(wrapper.querySelector("svg.search-field-icon")).not.toBeNull();
    expect(input.classList.contains("search-field-input")).toBe(true);
    // The form-control class would paint a second box inside the field.
    expect(input.classList.contains("cm-textfield")).toBe(false);
    expect(input.hasAttribute("main-field")).toBe(true);
    expect(input.getAttribute("aria-label")).toBe("Find");
    expect(document.activeElement).toBe(input);
  });

  it("omits the replace controls in a read-only editor", () => {
    mounted = mount("alpha", { readOnly: true });
    expect(panel().querySelector("input[name=replace]")).toBeNull();
    expect(panel().querySelector("button[name=replace]")).toBeNull();
    expect(panel().querySelector("button[name=replaceAll]")).toBeNull();
  });

  it("keeps the replace controls, as form controls, in an editable editor", () => {
    mounted = mount("alpha", { readOnly: false });
    expect(field("replace").classList.contains("cm-textfield")).toBe(true);
    expect(panel().querySelector("button[name=replace]")).not.toBeNull();
    expect(panel().querySelector("button[name=replaceAll]")).not.toBeNull();
  });

  it("commits typing and the case, regexp and whole-word options to the editor's query", () => {
    mounted = mount("alpha", { readOnly: false });
    const { view } = mounted;
    type(queryInput(), "al");
    type(field("replace"), "be");
    for (const name of ["case", "re", "word"]) {
      field(name).checked = true;
      field(name).dispatchEvent(new Event("change", { bubbles: true }));
    }
    const query = getSearchQuery(view.state);
    expect(query.search).toBe("al");
    expect(query.replace).toBe("be");
    expect(query.caseSensitive).toBe(true);
    expect(query.regexp).toBe(true);
    expect(query.wholeWord).toBe(true);
  });

  it("reflects a query set from outside the panel", () => {
    mounted = mount("alpha", { readOnly: false });
    mounted.view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: "ph",
          replace: "PH",
          caseSensitive: true,
          regexp: true,
          wholeWord: true,
        })
      ),
    });
    expect(queryInput().value).toBe("ph");
    expect(field("replace").value).toBe("PH");
    expect(field("case").checked).toBe(true);
    expect(field("re").checked).toBe(true);
    expect(field("word").checked).toBe(true);
  });

  it("marks an unparseable pattern invalid, and an empty query not", () => {
    mounted = mount("alpha", { readOnly: true });
    const wrapper = queryInput().parentElement!;
    expect(wrapper.hasAttribute("data-invalid")).toBe(false);
    field("re").checked = true;
    field("re").dispatchEvent(new Event("change", { bubbles: true }));
    type(queryInput(), "(");
    expect(wrapper.getAttribute("data-invalid")).toBe("true");
    expect(queryInput().getAttribute("aria-invalid")).toBe("true");
    type(queryInput(), "a");
    expect(wrapper.hasAttribute("data-invalid")).toBe(false);
    expect(queryInput().hasAttribute("aria-invalid")).toBe(false);
    type(queryInput(), "(");
    expect(wrapper.getAttribute("data-invalid")).toBe("true");
    // The same text is a fine literal search once regexp is off.
    field("re").checked = false;
    field("re").dispatchEvent(new Event("change", { bubbles: true }));
    expect(wrapper.hasAttribute("data-invalid")).toBe(false);
  });

  it("commits a paste, which arrives as input with no keyup", () => {
    mounted = mount("alpha", { readOnly: true });
    queryInput().value = "lph";
    queryInput().dispatchEvent(new Event("input", { bubbles: true }));
    expect(getSearchQuery(mounted.view.state).search).toBe("lph");
  });

  it("the next, previous and all buttons drive the editor's matches", () => {
    mounted = mount("a1 a2 a3", { readOnly: true });
    const { view } = mounted;
    type(queryInput(), "a");
    const click = (name: string) =>
      panel().querySelector<HTMLButtonElement>(`button[name=${name}]`)!.click();
    click("next");
    click("next");
    expect(view.state.selection.main.from).toBe(3);
    click("prev");
    expect(view.state.selection.main.from).toBe(0);
    click("select");
    expect(view.state.selection.ranges.map((range) => range.from)).toEqual([0, 3, 6]);
  });

  it("Enter finds the next match and Shift+Enter the previous one", () => {
    mounted = mount("a1 a2 a3", { readOnly: true });
    const { view } = mounted;
    type(queryInput(), "a");
    const next = press(queryInput(), { key: "Enter", keyCode: 13 });
    expect(next.defaultPrevented).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    press(queryInput(), { key: "Enter", keyCode: 13 });
    expect(view.state.selection.main.from).toBe(3);
    press(queryInput(), { key: "Enter", keyCode: 13 });
    expect(view.state.selection.main.from).toBe(6);
    press(queryInput(), { key: "Enter", keyCode: 13, shiftKey: true });
    expect(view.state.selection.main.from).toBe(3);
  });

  it("keeps an outside query's literal flag when the panel next commits", () => {
    mounted = mount("a\\nb", { readOnly: true });
    const { view } = mounted;
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "a", literal: true })),
    });
    type(queryInput(), "a\\n");
    const query = getSearchQuery(view.state);
    expect(query.search).toBe("a\\n");
    expect(query.literal).toBe(true);
  });

  it("leaves IME keystrokes alone, including the boundary one that reports isComposing false", () => {
    mounted = mount("a1 a2", { readOnly: false });
    const { view } = mounted;
    type(queryInput(), "a");
    type(field("replace"), "b");
    press(queryInput(), { key: "Enter", keyCode: 13 });
    const selection = view.state.selection.main;
    const shapes: KeyboardEventInit[] = [
      { key: "Enter", keyCode: 229, isComposing: true },
      { key: "Enter", keyCode: 229, isComposing: false },
      { key: "Escape", keyCode: 229, isComposing: false },
    ];
    for (const target of [queryInput(), field("replace")]) {
      for (const shape of shapes) {
        expect(press(target, shape).defaultPrevented).toBe(false);
      }
    }
    expect(view.state.selection.main.eq(selection)).toBe(true);
    expect(view.state.doc.toString()).toBe("a1 a2");
    expect(searchPanelOpen(view.state)).toBe(true);
  });

  it("Enter in the replace field replaces the next match", () => {
    mounted = mount("a1 a2", { readOnly: false });
    const { view } = mounted;
    type(queryInput(), "a");
    type(field("replace"), "b");
    // The first press lands on a match; the next replaces it and moves on.
    press(field("replace"), { key: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("a1 a2");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([0, 1]);
    press(field("replace"), { key: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("b1 a2");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([3, 4]);
    press(field("replace"), { key: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("b1 b2");
  });

  it("the replace-all button replaces every match", () => {
    mounted = mount("a1 a2", { readOnly: false });
    type(queryInput(), "a");
    type(field("replace"), "b");
    panel().querySelector<HTMLButtonElement>("button[name=replaceAll]")!.click();
    expect(mounted.view.state.doc.toString()).toBe("b1 b2");
  });

  it("Escape closes the panel and hands focus back to the editor", () => {
    mounted = mount("alpha", { readOnly: true });
    const { view } = mounted;
    const event = press(queryInput(), { key: "Escape", keyCode: 27 });
    expect(event.defaultPrevented).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(document.querySelector(".cm-search")).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("the close button closes the panel and hands focus back to the editor", () => {
    mounted = mount("alpha", { readOnly: true });
    const { view } = mounted;
    const close = panel().querySelector<HTMLButtonElement>("button[name=close]")!;
    close.focus();
    close.click();
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("a reopened panel shows the query as it stands, including changes made while closed", () => {
    mounted = mount("alpha", { readOnly: false });
    const { view } = mounted;
    press(queryInput(), { key: "Escape", keyCode: 27 });
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "ph", replace: "PH", wholeWord: true })),
    });
    openSearchPanel(view);
    expect(queryInput().value).toBe("ph");
    expect(field("replace").value).toBe("PH");
    expect(field("word").checked).toBe(true);
    expect(document.activeElement).toBe(queryInput());
  });

  it("Mod-f inside the panel is consumed and keeps the query focused", () => {
    mounted = mount("alpha", { readOnly: true });
    type(queryInput(), "alp");
    const event = press(queryInput(), { key: "f", keyCode: 70, ...modKey() });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(queryInput());
    expect(queryInput().value).toBe("alp");
  });

  it("reopening while open refocuses the query field", () => {
    mounted = mount("alpha", { readOnly: true });
    const { view } = mounted;
    view.focus();
    expect(document.activeElement).not.toBe(queryInput());
    openSearchPanel(view);
    expect(document.activeElement).toBe(queryInput());
  });

  it("pressing the field's magnifier puts the caret in the query", () => {
    mounted = mount("alpha", { readOnly: true });
    mounted.view.focus();
    const icon = panel().querySelector("svg.search-field-icon")!;
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    icon.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(queryInput());
  });
});

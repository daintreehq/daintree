/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  applyContextReferenceProviders,
  contextReferenceChipField,
  currentContextReferenceProvidersEffects,
  type ContextReferenceChipProvider,
} from "../inputEditorExtensions/contextReferenceChip";
import { createFileChipField } from "../inputEditorExtensions/fileChip";
import { chipPendingDeleteField } from "../inputEditorExtensions/chipBackspace";
import {
  clearContextReferenceLabelsForTests,
  rememberContextReferenceLabel,
} from "@/lib/contextReferenceLabels";

const KANBAN: ReadonlyMap<string, ContextReferenceChipProvider> = new Map([
  ["rec", { pluginId: "acme.kanban", pluginName: "Kanban", label: "Cards" }],
]);

const views: EditorView[] = [];

function mount(doc: string, caret = doc.length): EditorView {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(caret),
      extensions: [chipPendingDeleteField, contextReferenceChipField, createFileChipField()],
    }),
  });
  views.push(view);
  return view;
}

function chips(view: EditorView, selector: string): string[] {
  return [...view.dom.querySelectorAll(selector)].map((el) => el.textContent ?? "");
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  clearContextReferenceLabelsForTests();
});

describe("context reference chips (#13795)", () => {
  it("draws a held prefix's reference under the plugin's name, and leaves others as text", () => {
    const view = mount("look at @rec:142 and @wiki:7 now", 0);
    applyContextReferenceProviders(view, KANBAN);
    expect(chips(view, ".cm-context-chip")).toEqual(["Kanban@rec:142"]);
    // `@rec:142` is the plugin's, never a file named `rec`.
    expect(chips(view, ".cm-file-chip")).toEqual(["@wiki"]);
  });

  it("names the item once it is known, and keeps a query being typed as text", () => {
    const typing = mount("@rec:fix");
    applyContextReferenceProviders(typing, KANBAN);
    expect(chips(typing, ".cm-context-chip")).toEqual([]);

    rememberContextReferenceLabel("acme.kanban", { prefix: "rec", id: "142" }, "Fix login");
    const picked = mount("@rec:142 ");
    applyContextReferenceProviders(picked, KANBAN);
    expect(chips(picked, ".cm-context-chip")).toEqual(["KanbanFix login"]);
  });

  it("comes back to the current providers after an older state is restored", () => {
    const view = mount("@rec:1 ", 0);
    const stashed = view.state;
    applyContextReferenceProviders(view, KANBAN);
    view.setState(stashed);
    expect(chips(view, ".cm-context-chip")).toEqual([]);
    view.dispatch({ effects: currentContextReferenceProvidersEffects(view) });
    expect(chips(view, ".cm-context-chip")).toEqual(["Kanban@rec:1"]);
  });
});

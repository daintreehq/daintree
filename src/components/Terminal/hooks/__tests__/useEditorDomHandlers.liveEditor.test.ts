// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ setPreferredTerminalFocusTarget: vi.fn() }) },
}));

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => ({ isVoiceSubmitting: () => false }) },
}));

const { useEditorDomHandlers } = await import("../useEditorDomHandlers");

type Params = Parameters<typeof useEditorDomHandlers>[0];

// Named for the ordinary test tier rather than `.integration.`, which
// `vitest.config.ts` excludes — a regression test for #11710 that CI never runs
// is worth nothing. Driven through a real EditorView because what the fix turns
// on is not the predicate's return value but what CodeMirror does with it: the
// built-in drop handler this defers to is reached through the same dispatch
// table, and only a live view puts the two in their production ordering.
const views: EditorView[] = [];

function mountEditor(extensions: Extension[]) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "", extensions }),
  });
  views.push(view);
  return { view, parent };
}

function params(): Params {
  return {
    latestRef: { current: null },
    editorViewRef: { current: null },
    isComposingRef: { current: false },
    handledEnterRef: { current: false },
    lastEnterKeydownNewlineRef: { current: false },
    submitAfterCompositionRef: { current: false },
    applyAutocompleteSelection: vi.fn(() => true),
    sendFromEditor: vi.fn(),
    rootRef: { current: null },
    setActiveCompletionContext: vi.fn(),
    participatesInTerminalFocusRef: { current: true },
  };
}

function hookExtension(): Extension {
  const { result } = renderHook(() => useEditorDomHandlers(params()));
  return result.current;
}

/** Stubbed rather than spied: jsdom finishes a real read across later tasks, so
 * an unsuppressed one would reach CodeMirror's insert after the test that
 * provoked it has already torn its editor down. */
function watchFileReads() {
  return vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(() => {});
}

function fileDrop() {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files", "text/plain"],
      files: [new File(["secret contents"], "notes.txt", { type: "text/plain" })],
      getData: vi.fn(() => ""),
    },
  });
  return event;
}

function textDrop() {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  // Resolving to an empty string keeps CodeMirror short of `dropText`, which
  // needs `posAtCoords` and therefore a layout jsdom does not have. The call
  // itself is the signal: reaching it means the built-in was not suppressed.
  const getData = vi.fn(() => "");
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["text/plain"], files: [], getData },
  });
  return { event, getData };
}

afterEach(() => {
  cleanup();
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useEditorDomHandlers installed in a live editor", () => {
  it("keeps a dropped file out of the document instead of reading it as text", () => {
    const readAsText = watchFileReads();
    const { view } = mountEditor([hookExtension()]);
    const event = fileDrop();

    view.contentDOM.dispatchEvent(event);

    expect(readAsText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
    expect(event.defaultPrevented).toBe(true);
  });

  // The control for the assertion above: without the extension the same drop
  // does reach CodeMirror's FileReader, so a green result there is the fix
  // working rather than jsdom failing to deliver the event at all.
  it("reads the file without the extension, proving the drop is delivered", () => {
    const readAsText = watchFileReads();
    const { view } = mountEditor([]);

    view.contentDOM.dispatchEvent(fileDrop());

    expect(readAsText).toHaveBeenCalledTimes(1);
  });

  it("still lets CodeMirror handle a text-only drop", () => {
    const { view } = mountEditor([hookExtension()]);
    const { event, getData } = textDrop();

    view.contentDOM.dispatchEvent(event);

    expect(getData).toHaveBeenCalledWith("Text");
    // CodeMirror declines the empty text itself. Had the handler claimed the
    // drag, the event would have come back prevented instead.
    expect(event.defaultPrevented).toBe(false);
  });

  // The chip is inserted by a React handler on an ancestor of the content DOM,
  // so claiming the drop here has to stop at preventing the default.
  it("lets a claimed file drop reach the ancestor that inserts the chip", () => {
    watchFileReads();
    const { view, parent } = mountEditor([hookExtension()]);
    const ancestor = vi.fn();
    parent.addEventListener("drop", ancestor);

    view.contentDOM.dispatchEvent(fileDrop());

    expect(ancestor).toHaveBeenCalledTimes(1);
  });
});

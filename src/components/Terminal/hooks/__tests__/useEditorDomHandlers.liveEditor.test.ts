// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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
  };
}

function hookExtension(overrides: Partial<Params> = {}): Extension {
  const { result } = renderHook(() => useEditorDomHandlers({ ...params(), ...overrides }));
  return result.current;
}

type Latest = NonNullable<Params["latestRef"]["current"]>;

function agentLatest(overrides: Partial<Latest> = {}): Latest {
  return {
    disabled: false,
    isAutocompleteOpen: false,
    autocompleteItems: [],
    staleItemKeys: new Set(),
    selectedIndex: 0,
    value: "",
    terminalId: "t1",
    voiceId: "t1",
    onSendKey: vi.fn(),
    isVoiceActiveForPanel: false,
    isExpanded: false,
    altChords: ["p", "t", "o"],
    ...overrides,
  };
}

/** Option+P as macOS delivers it with Option as a third-level shift: the key is
 * the glyph, the key code is still the letter's. */
function optionKeydown(key: string, keyCode: number, code: string) {
  return new KeyboardEvent("keydown", {
    key,
    code,
    keyCode,
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
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

describe("an agent's documented Option chords in a live editor", () => {
  it("sends Option+P to the agent and leaves the draft as it was", () => {
    const latest = agentLatest();
    const { view } = mountEditor([hookExtension({ latestRef: { current: latest } })]);
    view.dispatch({ changes: { from: 0, insert: "refactor the parser" } });
    const event = optionKeydown("π", 80, "KeyP");

    view.contentDOM.dispatchEvent(event);

    expect(latest.onSendKey).toHaveBeenCalledWith("alt+p");
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("refactor the parser");
  });

  it("leaves a chord the agent doesn't document to type", () => {
    const latest = agentLatest();
    const { view } = mountEditor([hookExtension({ latestRef: { current: latest } })]);
    const event = optionKeydown("@", 76, "KeyL");

    view.contentDOM.dispatchEvent(event);

    expect(latest.onSendKey).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Option+P to type when the composer's terminal declares no chords", () => {
    const latest = agentLatest({ altChords: undefined });
    const { view } = mountEditor([hookExtension({ latestRef: { current: latest } })]);
    const event = optionKeydown("π", 80, "KeyP");

    view.contentDOM.dispatchEvent(event);

    expect(latest.onSendKey).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

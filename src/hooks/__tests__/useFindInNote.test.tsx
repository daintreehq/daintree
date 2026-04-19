// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  search,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  openSearchPanel,
} from "@codemirror/search";
import { useFindInNote } from "../useFindInNote";

function createRealEditorView(initialDoc = ""): EditorView {
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      search({
        createPanel: () => {
          const dom = document.createElement("div");
          dom.style.display = "none";
          return { dom };
        },
      }),
    ],
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ state, parent });
  openSearchPanel(view);
  return view;
}

function renderFindHook(isActive: boolean, view: EditorView | null) {
  return renderHook(() => {
    const ref = useRef<EditorView | null>(view);
    return useFindInNote(ref, isActive);
  });
}

let view: EditorView | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  view = null;
});

afterEach(() => {
  if (view) view.destroy();
  vi.restoreAllMocks();
});

describe("useFindInNote", () => {
  it("starts closed with empty state", () => {
    const { result } = renderFindHook(false, null);
    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeMatch).toBe(0);
    expect(result.current.caseSensitive).toBe(false);
    expect(result.current.regexp).toBe(false);
  });

  it("opens and closes the find bar", () => {
    view = createRealEditorView("hello world hello");
    const { result } = renderFindHook(true, view);

    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.query).toBe("");
  });

  it("dispatches setSearchQuery when setQuery is called", () => {
    view = createRealEditorView("hello world hello universe");
    const { result } = renderFindHook(true, view);

    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));

    expect(result.current.query).toBe("hello");
    const cur = getSearchQuery(view.state);
    expect(cur.search).toBe("hello");
  });

  it("does not dispatch during IME composition", () => {
    view = createRealEditorView("hello hello");
    const { result } = renderFindHook(true, view);

    act(() => result.current.open());
    act(() => {
      result.current.isComposingRef.current = true;
      result.current.setQuery("partial");
    });

    expect(result.current.query).toBe("partial");
    const cur = getSearchQuery(view.state);
    expect(cur.search).toBe("");
  });

  it("toggleCase updates state and reapplies query with new flag", () => {
    view = createRealEditorView("Hello hello");
    const { result } = renderFindHook(true, view);

    act(() => result.current.setQuery("hello"));
    act(() => result.current.toggleCase());

    expect(result.current.caseSensitive).toBe(true);
    const cur = getSearchQuery(view.state);
    expect(cur.caseSensitive).toBe(true);
  });

  it("toggleRegexp updates state and reapplies query with new flag", () => {
    view = createRealEditorView("abc123");
    const { result } = renderFindHook(true, view);

    act(() => result.current.setQuery("\\d+"));
    act(() => result.current.toggleRegexp());

    expect(result.current.regexp).toBe(true);
    const cur = getSearchQuery(view.state);
    expect(cur.regexp).toBe(true);
  });

  it("emptying the query clears counts", () => {
    view = createRealEditorView("hello hello");
    const { result } = renderFindHook(true, view);

    act(() => result.current.setQuery("hello"));
    act(() => result.current.setQuery(""));

    expect(result.current.matchCount).toBe(0);
    expect(result.current.activeMatch).toBe(0);
  });

  it("opens find bar on daintree:find-in-panel when active", () => {
    view = createRealEditorView("hello");
    const { result } = renderFindHook(true, view);

    act(() => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });

    expect(result.current.isOpen).toBe(true);
  });

  it("does not open find bar on daintree:find-in-panel when inactive", () => {
    view = createRealEditorView("hello");
    const { result } = renderFindHook(false, view);

    act(() => {
      window.dispatchEvent(new Event("daintree:find-in-panel"));
    });

    expect(result.current.isOpen).toBe(false);
  });

  it("cleans up window listener on unmount", () => {
    view = createRealEditorView("hello");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderFindHook(true, view);

    unmount();
    const calls = removeSpy.mock.calls.filter((c) => c[0] === "daintree:find-in-panel");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("goNext/goPrev are no-ops when query is empty", () => {
    view = createRealEditorView("hello");
    const { result } = renderFindHook(true, view);

    // Should not throw or change state
    act(() => result.current.goNext());
    act(() => result.current.goPrev());
    expect(result.current.matchCount).toBe(0);
  });

  it("survives invalid regex without throwing", () => {
    view = createRealEditorView("abc");
    const { result } = renderFindHook(true, view);

    act(() => result.current.toggleRegexp());
    act(() => result.current.setQuery("("));
    // Should not throw; match count stays 0 for invalid regex
    expect(result.current.matchCount).toBe(0);
    expect(result.current.regexp).toBe(true);
  });

  it("counts matches after query via editor update", () => {
    view = createRealEditorView("hello hello hello");
    const { result } = renderFindHook(true, view);

    act(() => {
      view!.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "hello" })),
      });
    });

    // handleEditorUpdate is called by CodeMirror on transactions in a real view, but in our
    // renderHook wrapper it isn't wired — invoke manually to verify the counting logic.
    act(() => {
      result.current.handleEditorUpdate({
        state: view!.state,
        docChanged: false,
        selectionSet: false,
        transactions: [
          { effects: [setSearchQuery.of(new SearchQuery({ search: "hello" }))] } as never,
        ],
      });
    });

    expect(result.current.matchCount).toBe(3);
  });
});

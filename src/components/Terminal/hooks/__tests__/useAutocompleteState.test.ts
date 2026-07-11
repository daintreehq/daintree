// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutocompleteState } from "../useAutocompleteState";
import type { ActiveCompletionContext } from "../../hybridInputParsing";
import type { AutocompleteItem } from "../../AutocompleteMenu";

type Props = Parameters<typeof useAutocompleteState>[0];

function item(key: string): AutocompleteItem {
  return { key, label: key, insertText: key };
}

function atContext(query: string): ActiveCompletionContext {
  return { triggerChar: "@", start: 0, tokenEnd: query.length + 1, query };
}

describe("useAutocompleteState", () => {
  let setSelectedIndex: ReturnType<typeof vi.fn<Props["setSelectedIndex"]>>;
  let setActiveCompletionContext: ReturnType<typeof vi.fn<Props["setActiveCompletionContext"]>>;
  let lastQueryRef: { current: string };
  let rootRef: { current: HTMLDivElement | null };

  beforeEach(() => {
    setSelectedIndex = vi.fn<Props["setSelectedIndex"]>();
    setActiveCompletionContext = vi.fn<Props["setActiveCompletionContext"]>();
    lastQueryRef = { current: "" };
    rootRef = { current: document.createElement("div") };
  });

  function base(overrides: Partial<Props> = {}): Props {
    return {
      isAutocompleteOpen: false,
      activeCompletionContext: null,
      autocompleteItems: [],
      rootRef: rootRef as Props["rootRef"],
      selectedIndex: 0,
      setSelectedIndex,
      lastQueryRef: lastQueryRef as Props["lastQueryRef"],
      setActiveCompletionContext,
      ...overrides,
    };
  }

  function render(initial: Props) {
    return renderHook((props: Props) => useAutocompleteState(props), { initialProps: initial });
  }

  describe("selection", () => {
    it("resets to the top on a new completion session", () => {
      render(
        base({
          activeCompletionContext: { triggerChar: "/", start: 0, tokenEnd: 4, query: "hel" },
          autocompleteItems: [item("/help"), item("/hey")],
          selectedIndex: 3,
        })
      );
      expect(setSelectedIndex).toHaveBeenCalledWith(0);
    });

    it("preserves the selected key when async items merge in for the same query", () => {
      const { rerender } = render(
        base({
          activeCompletionContext: atContext("src"),
          autocompleteItems: [item("f1")],
          selectedIndex: 0,
        })
      );
      setSelectedIndex.mockClear();

      // A slower provider inserts an item BEFORE the selected one.
      rerender(
        base({
          activeCompletionContext: atContext("src"),
          autocompleteItems: [item("f0"), item("f1")],
          selectedIndex: 0,
        })
      );
      expect(setSelectedIndex).toHaveBeenCalledWith(1);
    });

    it("clamps into range when the selected key vanishes", () => {
      const { rerender } = render(
        base({
          activeCompletionContext: atContext("src"),
          autocompleteItems: [item("a"), item("b"), item("c")],
          selectedIndex: 0,
        })
      );
      setSelectedIndex.mockClear();

      rerender(
        base({
          activeCompletionContext: atContext("src"),
          autocompleteItems: [item("x")],
          selectedIndex: 2,
        })
      );
      expect(setSelectedIndex).toHaveBeenCalledWith(0);
    });
  });

  describe("outside click", () => {
    it("registers pointerdown listener when autocomplete is open", () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");

      const { unmount } = render(base({ isAutocompleteOpen: true }));

      expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);

      unmount();
      expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    });

    it("ignores an outside pointerdown when autocomplete is closed", () => {
      render(base({ isAutocompleteOpen: false }));
      const outside = document.createElement("div");
      document.body.appendChild(outside);

      act(() => {
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });

      expect(setActiveCompletionContext).not.toHaveBeenCalled();
    });

    it("clears the context when clicking outside root", () => {
      render(base({ isAutocompleteOpen: true }));
      const outside = document.createElement("div");
      document.body.appendChild(outside);

      act(() => {
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });

      expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
    });

    it("does not clear the context when clicking inside root", () => {
      render(base({ isAutocompleteOpen: true }));

      act(() => {
        rootRef.current!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });

      expect(setActiveCompletionContext).not.toHaveBeenCalled();
    });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { Dispatch, SetStateAction } from "react";
import type { ActiveCompletionContext } from "../../hybridInputParsing";
import type { AutocompleteItem } from "../../AutocompleteMenu";
import { useEditorKeymap } from "../useEditorKeymap";

type KeymapParams = Parameters<typeof useEditorKeymap>[0];
type LatestShape = NonNullable<KeymapParams["latestRef"]["current"]>;

const fileItem: AutocompleteItem = {
  key: "src/a.ts",
  label: "a.ts",
  insertText: "src/a.ts",
  enterAction: "insert",
  insert: "literal",
};

function makeLatest(overrides: Partial<LatestShape> = {}): LatestShape {
  return {
    terminalId: "t1",
    projectId: undefined,
    disabled: false,
    isInitializing: false,
    isInHistoryMode: false,
    isAutocompleteOpen: true,
    autocompleteItems: [fileItem],
    staleItemKeys: new Set<string>(),
    selectedIndex: 0,
    value: "@a",
    onSendKey: undefined,
    isVoiceActiveForPanel: false,
    isExpanded: false,
    ...overrides,
  };
}

describe("useEditorKeymap", () => {
  let applyAutocompleteSelection: ReturnType<typeof vi.fn<(mode: "enter" | "complete") => boolean>>;
  let sendFromEditor: ReturnType<typeof vi.fn<() => void>>;
  let cancelVoiceWaitSubmit: ReturnType<typeof vi.fn<() => boolean>>;
  let setActiveCompletionContext: ReturnType<
    typeof vi.fn<Dispatch<SetStateAction<ActiveCompletionContext | null>>>
  >;

  beforeEach(() => {
    applyAutocompleteSelection = vi.fn<(mode: "enter" | "complete") => boolean>(() => true);
    sendFromEditor = vi.fn<() => void>();
    cancelVoiceWaitSubmit = vi.fn<() => boolean>(() => false);
    setActiveCompletionContext = vi.fn<Dispatch<SetStateAction<ActiveCompletionContext | null>>>();
  });

  function renderKeymap(latest: LatestShape) {
    const params: KeymapParams = {
      latestRef: { current: latest },
      editorViewRef: { current: null },
      isComposingRef: { current: false },
      handledEnterRef: { current: false },
      editableCompartmentRef: { current: new Compartment() },
      historyPaletteOpenRef: { current: null },
      applyAutocompleteSelection,
      handleHistoryNavigation: vi.fn<(direction: "up" | "down") => boolean>(() => false),
      sendFromEditor,
      startVoiceWaitSubmit: vi.fn<() => void>(),
      cancelVoiceWaitSubmit,
      stashEditorState:
        vi.fn<(terminalId: string, state: EditorState, projectId?: string) => void>(),
      popStashedEditorState: vi.fn<
        (terminalId: string, projectId?: string) => EditorState | undefined
      >(() => undefined),
      setActiveCompletionContext,
      setIsExpanded: vi.fn<Dispatch<SetStateAction<boolean>>>(),
      setSelectedIndex: vi.fn<Dispatch<SetStateAction<number>>>(),
    };
    const { result } = renderHook(() => useEditorKeymap(params));
    return { handlers: result.current.handlersRef.current! };
  }

  describe("Enter", () => {
    it("applies the selected item on Enter (item owns insert vs execute)", () => {
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("enter");
      expect(sendFromEditor).not.toHaveBeenCalled();
    });

    it("applies on Enter for a command item too (no mode inference in keymap)", () => {
      const { handlers } = renderKeymap(
        makeLatest({
          autocompleteItems: [
            { key: "/help", label: "/help", insertText: "/help", enterAction: "execute" },
          ],
          value: "/he",
        })
      );
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("enter");
    });

    it("falls through to the normal send when the selected item is stale", () => {
      const { handlers } = renderKeymap(makeLatest({ staleItemKeys: new Set(["src/a.ts"]) }));
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).not.toHaveBeenCalled();
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

    it("routes stale-Enter on empty text to onSendKey", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(
        makeLatest({ staleItemKeys: new Set(["src/a.ts"]), value: "   ", onSendKey })
      );
      expect(handlers.onEnter()).toBe(true);
      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(onSendKey).toHaveBeenCalledWith("enter");
    });
  });

  describe("Tab", () => {
    it("completes the selected item when fresh", () => {
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("complete");
    });

    it("swallows Tab without completing when the selected item is stale", () => {
      const { handlers } = renderKeymap(makeLatest({ staleItemKeys: new Set(["src/a.ts"]) }));
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).not.toHaveBeenCalled();
    });
  });

  describe("Escape", () => {
    it("clears the active completion context", () => {
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEscape()).toBe(true);
      expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
    });

    it("cancels a pending voice wait-submit before touching autocomplete", () => {
      cancelVoiceWaitSubmit.mockReturnValue(true);
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEscape()).toBe(true);
      expect(setActiveCompletionContext).not.toHaveBeenCalled();
    });
  });
});

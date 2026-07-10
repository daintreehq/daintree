// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Compartment } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { Dispatch, SetStateAction } from "react";
import type {
  AtFileContext,
  SlashCommandContext,
  AtDiffContext,
  AtTerminalContext,
  AtSelectionContext,
} from "../../hybridInputParsing";
import { useEditorKeymap } from "../useEditorKeymap";

type KeymapParams = Parameters<typeof useEditorKeymap>[0];
type LatestShape = NonNullable<KeymapParams["latestRef"]["current"]>;

function makeLatest(overrides: Partial<LatestShape> = {}): LatestShape {
  return {
    terminalId: "t1",
    projectId: undefined,
    disabled: false,
    isInitializing: false,
    isInHistoryMode: false,
    activeMode: "file",
    isAutocompleteOpen: true,
    autocompleteItems: [{ key: "src/a.ts", label: "a.ts", insertText: "src/a.ts" }],
    isResultsStale: false,
    selectedIndex: 0,
    value: "@a",
    onSendKey: undefined,
    isVoiceActiveForPanel: false,
    isExpanded: false,
    ...overrides,
  };
}

describe("useEditorKeymap", () => {
  let applyAutocompleteSelection: ReturnType<
    typeof vi.fn<(action: "insert" | "execute") => boolean>
  >;
  let sendFromEditor: ReturnType<typeof vi.fn<() => void>>;
  let cancelVoiceWaitSubmit: ReturnType<typeof vi.fn<() => boolean>>;
  let setAtContext: ReturnType<typeof vi.fn<Dispatch<SetStateAction<AtFileContext | null>>>>;
  let setSlashContext: ReturnType<
    typeof vi.fn<Dispatch<SetStateAction<SlashCommandContext | null>>>
  >;
  let setDiffContext: ReturnType<typeof vi.fn<Dispatch<SetStateAction<AtDiffContext | null>>>>;
  let setTerminalContext: ReturnType<
    typeof vi.fn<Dispatch<SetStateAction<AtTerminalContext | null>>>
  >;
  let setSelectionContext: ReturnType<
    typeof vi.fn<Dispatch<SetStateAction<AtSelectionContext | null>>>
  >;

  beforeEach(() => {
    applyAutocompleteSelection = vi.fn<(action: "insert" | "execute") => boolean>(() => true);
    sendFromEditor = vi.fn<() => void>();
    cancelVoiceWaitSubmit = vi.fn<() => boolean>(() => false);
    setAtContext = vi.fn<Dispatch<SetStateAction<AtFileContext | null>>>();
    setSlashContext = vi.fn<Dispatch<SetStateAction<SlashCommandContext | null>>>();
    setDiffContext = vi.fn<Dispatch<SetStateAction<AtDiffContext | null>>>();
    setTerminalContext = vi.fn<Dispatch<SetStateAction<AtTerminalContext | null>>>();
    setSelectionContext = vi.fn<Dispatch<SetStateAction<AtSelectionContext | null>>>();
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
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
      setIsExpanded: vi.fn<Dispatch<SetStateAction<boolean>>>(),
      setSelectedIndex: vi.fn<Dispatch<SetStateAction<number>>>(),
    };
    const { result } = renderHook(() => useEditorKeymap(params));
    return { handlers: result.current.handlersRef.current! };
  }

  describe("Enter", () => {
    it("accepts the selected item when results are fresh", () => {
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("insert");
      expect(sendFromEditor).not.toHaveBeenCalled();
    });

    it("executes instead of inserting in command mode", () => {
      const { handlers } = renderKeymap(
        makeLatest({
          activeMode: "command",
          autocompleteItems: [{ key: "/help", label: "/help", insertText: "/help" }],
          value: "/he",
        })
      );
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("execute");
    });

    it("falls through to the normal send when results are stale", () => {
      const { handlers } = renderKeymap(makeLatest({ isResultsStale: true }));
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).not.toHaveBeenCalled();
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

    it("routes stale-Enter on empty text to onSendKey", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(
        makeLatest({ isResultsStale: true, value: "   ", onSendKey })
      );
      expect(handlers.onEnter()).toBe(true);
      expect(sendFromEditor).not.toHaveBeenCalled();
      expect(onSendKey).toHaveBeenCalledWith("enter");
    });
  });

  describe("Tab", () => {
    it("inserts the selected item when results are fresh", () => {
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("insert");
    });

    it("swallows Tab without inserting when results are stale", () => {
      const { handlers } = renderKeymap(makeLatest({ isResultsStale: true }));
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).not.toHaveBeenCalled();
    });
  });

  describe("Escape", () => {
    it("clears every autocomplete context, including terminal and selection", () => {
      const { handlers } = renderKeymap(makeLatest({ activeMode: "terminal" }));
      expect(handlers.onEscape()).toBe(true);
      expect(setAtContext).toHaveBeenCalledWith(null);
      expect(setSlashContext).toHaveBeenCalledWith(null);
      expect(setDiffContext).toHaveBeenCalledWith(null);
      expect(setTerminalContext).toHaveBeenCalledWith(null);
      expect(setSelectionContext).toHaveBeenCalledWith(null);
    });

    it("cancels a pending voice wait-submit before touching autocomplete", () => {
      cancelVoiceWaitSubmit.mockReturnValue(true);
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEscape()).toBe(true);
      expect(setAtContext).not.toHaveBeenCalled();
      expect(setTerminalContext).not.toHaveBeenCalled();
    });
  });
});

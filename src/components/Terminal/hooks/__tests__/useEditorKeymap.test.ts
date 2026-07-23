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
    isAgentTerminal: false,
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
  let handleHistoryNavigation: ReturnType<typeof vi.fn<(direction: "up" | "down") => boolean>>;
  let setSelectedIndex: ReturnType<typeof vi.fn<Dispatch<SetStateAction<number>>>>;

  beforeEach(() => {
    applyAutocompleteSelection = vi.fn<(mode: "enter" | "complete") => boolean>(() => true);
    sendFromEditor = vi.fn<() => void>();
    cancelVoiceWaitSubmit = vi.fn<() => boolean>(() => false);
    setActiveCompletionContext = vi.fn<Dispatch<SetStateAction<ActiveCompletionContext | null>>>();
    handleHistoryNavigation = vi.fn<(direction: "up" | "down") => boolean>(() => false);
    setSelectedIndex = vi.fn<Dispatch<SetStateAction<number>>>();
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
      handleHistoryNavigation,
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
      setSelectedIndex,
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

  // Arrow routing between host prompt-history and the agent's own terminal TUI
  // (e.g. Codex's `/model` picker). Regression matrix for issue #11218: empty
  // ArrowUp on an agent terminal must reach the terminal, not recall history,
  // while shell-terminal recall and mid-recall navigation stay intact.
  describe("Arrow routing (issue #11218)", () => {
    it("agent terminal: empty ArrowUp at rest forwards to the terminal, never host history", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      // Would recall a history entry if consulted — asserting it is not called
      // directly reproduces and guards against the original bug.
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({ isAgentTerminal: true, isAutocompleteOpen: false, value: "", onSendKey })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(onSendKey).toHaveBeenCalledWith("up");
      expect(handleHistoryNavigation).not.toHaveBeenCalled();
    });

    it("shell terminal: empty ArrowUp at rest recalls host history, not the terminal", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({ isAgentTerminal: false, isAutocompleteOpen: false, value: "", onSendKey })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("up");
      expect(onSendKey).not.toHaveBeenCalled();
    });

    it("agent terminal: empty ArrowDown at rest forwards to the terminal (unchanged)", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(false);
      const { handlers } = renderKeymap(
        makeLatest({ isAgentTerminal: true, isAutocompleteOpen: false, value: "", onSendKey })
      );
      expect(handlers.onArrowDown()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("down");
      expect(onSendKey).toHaveBeenCalledWith("down");
    });

    it("shell terminal: empty ArrowDown at rest forwards to the terminal (unchanged)", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(false);
      const { handlers } = renderKeymap(
        makeLatest({ isAgentTerminal: false, isAutocompleteOpen: false, value: "", onSendKey })
      );
      expect(handlers.onArrowDown()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("down");
      expect(onSendKey).toHaveBeenCalledWith("down");
    });

    it("agent terminal: mid-recall ArrowUp still navigates host history", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: true,
          isAutocompleteOpen: false,
          isInHistoryMode: true,
          value: "recalled command",
          onSendKey,
        })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("up");
      expect(onSendKey).not.toHaveBeenCalled();
    });

    it("agent terminal: mid-recall ArrowDown still navigates host history", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: true,
          isAutocompleteOpen: false,
          isInHistoryMode: true,
          value: "recalled command",
          onSendKey,
        })
      );
      expect(handlers.onArrowDown()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("down");
      expect(onSendKey).not.toHaveBeenCalled();
    });

    it("shell terminal: mid-recall ArrowUp still navigates host history", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: false,
          isAutocompleteOpen: false,
          isInHistoryMode: true,
          value: "recalled command",
          onSendKey,
        })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("up");
      expect(onSendKey).not.toHaveBeenCalled();
    });

    it("agent terminal: whitespace-only ArrowUp is treated as empty and forwarded", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({ isAgentTerminal: true, isAutocompleteOpen: false, value: "   ", onSendKey })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(onSendKey).toHaveBeenCalledWith("up");
      expect(handleHistoryNavigation).not.toHaveBeenCalled();
    });

    it("agent terminal: empty ArrowUp without onSendKey is unhandled and never recalls history", () => {
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: true,
          isAutocompleteOpen: false,
          value: "",
          onSendKey: undefined,
        })
      );
      expect(handlers.onArrowUp()).toBe(false);
      expect(handleHistoryNavigation).not.toHaveBeenCalled();
    });

    it("agent terminal: an open autocomplete menu wins over terminal routing", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: true,
          isAutocompleteOpen: true,
          autocompleteItems: [fileItem],
          value: "",
          onSendKey,
        })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(setSelectedIndex).toHaveBeenCalled();
      expect(onSendKey).not.toHaveBeenCalled();
      expect(handleHistoryNavigation).not.toHaveBeenCalled();
    });

    it("agent terminal: non-empty input outside history mode is left to CodeMirror", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: true,
          isAutocompleteOpen: false,
          isInHistoryMode: false,
          value: "some draft",
          onSendKey,
        })
      );
      expect(handlers.onArrowUp()).toBe(false);
      expect(onSendKey).not.toHaveBeenCalled();
      expect(handleHistoryNavigation).not.toHaveBeenCalled();
    });

    it("agent terminal: empty ArrowUp in history mode navigates host history, not the terminal", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      // Guards the `!isInHistoryMode` half of the new predicate: an empty agent
      // input already cycling host history must keep navigating it, not forward.
      handleHistoryNavigation.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({
          isAgentTerminal: true,
          isAutocompleteOpen: false,
          isInHistoryMode: true,
          value: "",
          onSendKey,
        })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("up");
      expect(onSendKey).not.toHaveBeenCalled();
    });

    it("shell terminal: empty ArrowUp with no host history falls through to the terminal", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      // Fresh shell with no Daintree prompt history — ArrowUp must still reach
      // the shell/readline history via onSendKey.
      handleHistoryNavigation.mockReturnValue(false);
      const { handlers } = renderKeymap(
        makeLatest({ isAgentTerminal: false, isAutocompleteOpen: false, value: "", onSendKey })
      );
      expect(handlers.onArrowUp()).toBe(true);
      expect(handleHistoryNavigation).toHaveBeenCalledWith("up");
      expect(onSendKey).toHaveBeenCalledWith("up");
    });
  });
});

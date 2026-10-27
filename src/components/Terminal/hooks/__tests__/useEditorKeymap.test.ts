// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import { createComposerHistory } from "../../inputEditorExtensions/composerHistory";
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
  let applyAutocompleteSelection: ReturnType<
    typeof vi.fn<(mode: "enter" | "complete", index?: number) => boolean>
  >;
  let sendFromEditor: ReturnType<typeof vi.fn<() => void>>;
  let cancelVoiceWaitSubmit: ReturnType<typeof vi.fn<() => boolean>>;
  let handleDictationEscape: ReturnType<typeof vi.fn<() => boolean>>;
  let startVoiceWaitSubmit: ReturnType<typeof vi.fn<() => void>>;
  let hasPendingVoiceCorrection: ReturnType<typeof vi.fn<() => boolean>>;
  let setActiveCompletionContext: ReturnType<
    typeof vi.fn<Dispatch<SetStateAction<ActiveCompletionContext | null>>>
  >;
  let handleHistoryNavigation: ReturnType<typeof vi.fn<(direction: "up" | "down") => boolean>>;
  let setSelectedIndex: ReturnType<typeof vi.fn<Dispatch<SetStateAction<number>>>>;

  beforeEach(() => {
    applyAutocompleteSelection = vi.fn<(mode: "enter" | "complete", index?: number) => boolean>(
      () => true
    );
    sendFromEditor = vi.fn<() => void>();
    cancelVoiceWaitSubmit = vi.fn<() => boolean>(() => false);
    handleDictationEscape = vi.fn<() => boolean>(() => false);
    startVoiceWaitSubmit = vi.fn<() => void>();
    hasPendingVoiceCorrection = vi.fn<() => boolean>(() => false);
    setActiveCompletionContext = vi.fn<Dispatch<SetStateAction<ActiveCompletionContext | null>>>();
    handleHistoryNavigation = vi.fn<(direction: "up" | "down") => boolean>(() => false);
    setSelectedIndex = vi.fn<Dispatch<SetStateAction<number>>>();
  });

  function renderKeymap(latest: LatestShape, overrides: Partial<KeymapParams> = {}) {
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
      startVoiceWaitSubmit,
      cancelVoiceWaitSubmit,
      handleDictationEscape,
      hasPendingVoiceCorrection,
      stashEditorState:
        vi.fn<(terminalId: string, state: EditorState, projectId?: string) => void>(),
      popStashedEditorState: vi.fn<
        (terminalId: string, projectId?: string) => EditorState | undefined
      >(() => undefined),
      setActiveCompletionContext,
      setIsExpanded: vi.fn<Dispatch<SetStateAction<boolean>>>(),
      setSelectedIndex,
      ...overrides,
    };
    const { result } = renderHook(() => useEditorKeymap(params));
    return { handlers: result.current.handlersRef.current! };
  }

  describe("Enter", () => {
    it("waits for a finished passage's pending correction instead of sending raw text", () => {
      hasPendingVoiceCorrection.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({ isAutocompleteOpen: false, autocompleteItems: [], value: "hello wrld" })
      );
      expect(handlers.onEnter()).toBe(true);
      expect(startVoiceWaitSubmit).toHaveBeenCalledTimes(1);
      expect(sendFromEditor).not.toHaveBeenCalled();
    });

    it("sends straight away when no dictation is finishing or being corrected", () => {
      const { handlers } = renderKeymap(
        makeLatest({ isAutocompleteOpen: false, autocompleteItems: [], value: "hello" })
      );
      expect(handlers.onEnter()).toBe(true);
      expect(startVoiceWaitSubmit).not.toHaveBeenCalled();
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
    });

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

    it("sends what was typed when the menu shows rows but none is selected", () => {
      const { handlers } = renderKeymap(makeLatest({ selectedIndex: -1, value: "color: #333" }));
      expect(handlers.onEnter()).toBe(true);
      expect(applyAutocompleteSelection).not.toHaveBeenCalled();
      expect(sendFromEditor).toHaveBeenCalledTimes(1);
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
      const second: AutocompleteItem = { ...fileItem, key: "src/b.ts", insertText: "src/b.ts" };
      const { handlers } = renderKeymap(
        makeLatest({ autocompleteItems: [fileItem, second], selectedIndex: 1 })
      );
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("complete", 1);
    });

    it("completes the first row when nothing is selected", () => {
      const { handlers } = renderKeymap(makeLatest({ selectedIndex: -1 }));
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).toHaveBeenCalledWith("complete", 0);
    });

    it("swallows Tab when nothing is selected and the first row is stale", () => {
      const { handlers } = renderKeymap(
        makeLatest({ selectedIndex: -1, staleItemKeys: new Set(["src/a.ts"]) })
      );
      expect(handlers.onTab()).toBe(true);
      expect(applyAutocompleteSelection).not.toHaveBeenCalled();
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

    it("dismisses a menu still waiting on its rows and carries on to the agent", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(
        makeLatest({
          isAutocompleteOpen: false,
          autocompleteItems: [],
          activeCompletionContext: { triggerChar: "#", start: 0, tokenEnd: 1, query: "" },
          value: "#",
          onSendKey,
        })
      );
      expect(handlers.onEscape()).toBe(true);
      expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
      expect(onSendKey).toHaveBeenCalledWith("escape");
    });

    it("cancels a pending voice wait-submit before touching autocomplete", () => {
      cancelVoiceWaitSubmit.mockReturnValue(true);
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEscape()).toBe(true);
      expect(setActiveCompletionContext).not.toHaveBeenCalled();
    });

    it("closes an open autocomplete without ending the dictation", () => {
      handleDictationEscape.mockReturnValue(true);
      const { handlers } = renderKeymap(makeLatest());
      expect(handlers.onEscape()).toBe(true);
      expect(setActiveCompletionContext).toHaveBeenCalledWith(null);
      expect(handleDictationEscape).not.toHaveBeenCalled();
    });

    it("hands Escape to the dictation instead of the agent at rest", () => {
      handleDictationEscape.mockReturnValue(true);
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(makeLatest({ isAutocompleteOpen: false, onSendKey }));
      expect(handlers.onEscape()).toBe(true);
      expect(handleDictationEscape).toHaveBeenCalledOnce();
      expect(onSendKey).not.toHaveBeenCalled();
    });

    it("collapses an expanded editor without ending the dictation", () => {
      handleDictationEscape.mockReturnValue(true);
      const { handlers } = renderKeymap(
        makeLatest({ isAutocompleteOpen: false, isExpanded: true })
      );
      expect(handlers.onEscape()).toBe(true);
      expect(handleDictationEscape).not.toHaveBeenCalled();
    });

    it("hands Escape to the dictation even when the composer is disabled", () => {
      handleDictationEscape.mockReturnValue(true);
      const { handlers } = renderKeymap(makeLatest({ isAutocompleteOpen: false, disabled: true }));
      expect(handlers.onEscape()).toBe(true);
      expect(handleDictationEscape).toHaveBeenCalledOnce();
    });

    it("sends Escape to the agent when no dictation takes it", () => {
      const onSendKey = vi.fn<(key: string) => void>();
      const { handlers } = renderKeymap(makeLatest({ isAutocompleteOpen: false, onSendKey }));
      expect(handlers.onEscape()).toBe(true);
      expect(handleDictationEscape).toHaveBeenCalledOnce();
      expect(onSendKey).toHaveBeenCalledWith("escape");
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

    it("moves from no selection to the first row going down and the last going up", () => {
      const rows = ["a", "b", "c"].map((key) => ({ ...fileItem, key }));
      const { handlers } = renderKeymap(
        makeLatest({ autocompleteItems: rows, selectedIndex: -1, value: "#" })
      );
      handlers.onArrowDown();
      handlers.onArrowUp();
      const [down, up] = setSelectedIndex.mock.calls.map(([update]) =>
        typeof update === "function" ? update(-1) : update
      );
      expect(down).toBe(0);
      expect(up).toBe(2);
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
  describe("Stash", () => {
    it("stashes the draft with its own undo steps and leaves none in the empty composer", () => {
      const view = new EditorView({
        parent: document.createElement("div"),
        state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
      });
      view.dispatch({ changes: { from: 0, insert: "half a prompt" }, userEvent: "input.type" });
      let stashed: EditorState | undefined;
      const { handlers } = renderKeymap(makeLatest({ isAutocompleteOpen: false }), {
        editorViewRef: { current: view },
        stashEditorState: vi.fn((_id: string, state: EditorState) => {
          stashed = state;
        }),
        popStashedEditorState: vi.fn(() => stashed),
      });

      expect(handlers.onStash()).toBe(true);
      expect(view.state.doc.toString()).toBe("");
      expect(undoDepth(view.state)).toBe(0);

      expect(handlers.onPopStash()).toBe(true);
      expect(view.state.doc.toString()).toBe("half a prompt");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("");
      view.destroy();
    });
  });
});

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { Compartment } from "@codemirror/state";
import type { AutocompleteItem } from "../AutocompleteMenu";
import type { ActiveCompletionContext } from "../hybridInputParsing";
import { currentContextReferenceProvidersEffects } from "../inputEditorExtensions/contextReferenceChip";
import { clearComposerHistory } from "../inputEditorExtensions/composerHistory";
import { advanceComposerDraft } from "../inputEditorExtensions/composerDraftGeneration";
import { isComposerSendHeld } from "../uploads/pendingUploads";
import { rescanForgeReferences } from "../inputEditorExtensions/forgeReference";
import { currentVoiceCaretEffects, setVoiceCaret } from "../inputEditorExtensions/voiceCaret";
import { setPendingAIRanges } from "../inputEditorExtensions/base";

/**
 * Where one send goes in place of the composer's own `submitText` and
 * `onSendKey("enter")`: taken at the key press and carried with that send
 * alone, through a dictation's wait if it has one.
 */
export interface ComposerSendRoute {
  submitText: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
  sendEnter: () => void;
}

interface LatestRefShape {
  terminalId: string;
  projectId?: string;
  disabled: boolean;
  isInitializing: boolean;
  isAgentTerminal: boolean;
  isInHistoryMode: boolean;
  isAutocompleteOpen: boolean;
  /** A token being completed, whether or not its menu shows yet. */
  activeCompletionContext?: ActiveCompletionContext | null;
  autocompleteItems: AutocompleteItem[];
  staleItemKeys: ReadonlySet<string>;
  selectedIndex: number;
  value: string;
  onSendKey?: (key: string) => void;
  isVoiceActiveForPanel: boolean;
  isExpanded: boolean;
  /** Whose attachments still on their way hold an Enter on an empty draft too. */
  uploadSurface?: string;
  /** ⌘↩ sends as Enter does, by this route (`HybridInputBarProps.modEnterSend`). */
  modEnterSend?: () => ComposerSendRoute;
}

interface UseEditorKeymapParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  editorViewRef: React.RefObject<EditorView | null>;
  isComposingRef: React.RefObject<boolean>;
  handledEnterRef: React.MutableRefObject<boolean>;
  editableCompartmentRef: React.RefObject<Compartment>;
  historyPaletteOpenRef: React.RefObject<(() => void) | null>;
  applyAutocompleteSelection: (mode: "enter" | "complete", index?: number) => boolean;
  handleHistoryNavigation: (direction: "up" | "down") => boolean;
  sendFromEditor: (route?: ComposerSendRoute) => void;
  startVoiceWaitSubmit: (options?: { route?: ComposerSendRoute }) => void;
  cancelVoiceWaitSubmit: () => boolean;
  handleDictationEscape: () => boolean;
  hasPendingVoiceCorrection: () => boolean;
  stashEditorState: (terminalId: string, state: EditorView["state"], projectId?: string) => void;
  popStashedEditorState: (
    terminalId: string,
    projectId?: string
  ) => EditorView["state"] | undefined;
  setActiveCompletionContext: Dispatch<SetStateAction<ActiveCompletionContext | null>>;
  setIsExpanded: Dispatch<SetStateAction<boolean>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
}

interface KeymapHandlers {
  onEnter: (route?: ComposerSendRoute) => boolean;
  onModEnter: () => boolean;
  onEscape: () => boolean;
  onArrowUp: () => boolean;
  onArrowDown: () => boolean;
  onArrowLeft: () => boolean;
  onArrowRight: () => boolean;
  onTab: () => boolean;
  onCtrlC: (hasSelection: boolean) => boolean;
  onStash: () => boolean;
  onPopStash: () => boolean;
  onExpand: () => boolean;
  onHistorySearch: () => boolean;
}

export function useEditorKeymap({
  latestRef,
  editorViewRef,
  isComposingRef,
  handledEnterRef,
  editableCompartmentRef,
  historyPaletteOpenRef,
  applyAutocompleteSelection,
  handleHistoryNavigation,
  sendFromEditor,
  startVoiceWaitSubmit,
  cancelVoiceWaitSubmit,
  handleDictationEscape,
  hasPendingVoiceCorrection,
  stashEditorState,
  popStashedEditorState,
  setActiveCompletionContext,
  setIsExpanded,
  setSelectedIndex,
}: UseEditorKeymapParams) {
  // Route all keymap handlers through a ref holder updated in an effect. The keymap
  // extension is built once with stable callbacks that read the latest handlers via
  // the ref. This keeps the React Compiler happy — the createCustomKeymap call sees
  // only ref-free stable arrow wrappers, and actual ref/closure access happens after
  // render via the handlersRef indirection.
  const handlersRef = useRef<KeymapHandlers | null>(null);

  const buildHandlers = (): KeymapHandlers => ({
    // `route`: the way ⌘↩ sends. A completion row takes the key as its own and
    // sends nothing by it.
    onEnter: (route) => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;

      // Stale results (query changed since they were produced) must not be
      // accepted by a fast Enter — fall through to the normal send path so
      // the user's literal text wins over an outdated top match. Enter behavior
      // (insert vs execute) is owned by the selected item, not the trigger.
      const enterItem = latest.isAutocompleteOpen
        ? latest.autocompleteItems[latest.selectedIndex]
        : undefined;
      if (enterItem && !latest.staleItemKeys.has(enterItem.key)) {
        handledEnterRef.current = true;
        setTimeout(() => {
          handledEnterRef.current = false;
        }, 0);

        applyAutocompleteSelection("enter");
        return true;
      }

      if (latest.disabled) return true;

      // A finished passage whose correction is still on its way waits for it
      // too, so the send doesn't go out with the raw text (#14611).
      if (latest.isVoiceActiveForPanel || hasPendingVoiceCorrection()) {
        handledEnterRef.current = true;
        setTimeout(() => {
          handledEnterRef.current = false;
        }, 0);

        startVoiceWaitSubmit(route && { route });
        return true;
      }

      const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
      if (text.trim().length === 0) {
        handledEnterRef.current = true;
        setTimeout(() => {
          handledEnterRef.current = false;
        }, 0);

        // The image dropped on the empty draft is what this Enter was for.
        if (latest.uploadSurface !== undefined && isComposerSendHeld(latest.uploadSurface)) {
          return true;
        }
        if (route) route.sendEnter();
        else if (latest.onSendKey) latest.onSendKey("enter");
        return true;
      }

      handledEnterRef.current = true;
      setTimeout(() => {
        handledEnterRef.current = false;
      }, 0);

      sendFromEditor(route);
      return true;
    },
    // Enter's send, by the route the host gives for the press; with none, the
    // chord is left alone.
    onModEnter: () => {
      const route = latestRef.current?.modEnterSend?.();
      if (!route) return false;
      return handlersRef.current?.onEnter(route) ?? false;
    },
    onEscape: () => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;

      if (cancelVoiceWaitSubmit()) return true;

      if (latest.isAutocompleteOpen) {
        setActiveCompletionContext(null);
        return true;
      }
      // A `#` menu still waiting on its rows is dismissed before it can show,
      // and Escape carries on to wherever it would have gone.
      if (latest.activeCompletionContext) setActiveCompletionContext(null);

      if (latest.isExpanded) {
        setIsExpanded(false);
        return true;
      }

      // Dictating into this composer, Escape ends the dictation rather than
      // interrupting the agent (a cancel that discards words takes two); the
      // next one reaches the agent.
      if (handleDictationEscape()) return true;

      if (latest.disabled) return false;
      if (!latest.onSendKey) return false;

      latest.onSendKey("escape");
      return true;
    },
    onArrowUp: () => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;
      if (latest.disabled) return false;

      const resultsCount = latest.autocompleteItems.length;
      if (latest.isAutocompleteOpen && resultsCount > 0) {
        setSelectedIndex((prev) => {
          if (resultsCount === 0) return 0;
          // From no selection, up wraps to the last row as it does from the first.
          if (prev < 0) return resultsCount - 1;
          return (prev - 1 + resultsCount) % resultsCount;
        });
        return true;
      }

      const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
      const isEmpty = text.trim().length === 0;

      // Agent terminals: an empty-input ArrowUp at rest belongs to the agent's
      // own TUI (e.g. Codex's `/model` picker), not host prompt-history recall.
      // Forward it to the terminal and never fall back to history — this keeps
      // ArrowUp symmetric with ArrowDown (which already reaches the terminal at
      // rest) and leaves host history reachable via Mod-r. Mid-recall
      // (isInHistoryMode) still navigates host history in the block below.
      if (latest.isAgentTerminal && isEmpty && !latest.isInHistoryMode) {
        if (latest.onSendKey) {
          latest.onSendKey("up");
          return true;
        }
        return false;
      }

      const canNavigateHistory = isEmpty || latest.isInHistoryMode;

      if (canNavigateHistory) {
        if (handleHistoryNavigation("up")) return true;
        if (isEmpty && latest.onSendKey) {
          latest.onSendKey("up");
          return true;
        }
      }

      return false;
    },
    onArrowDown: () => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;
      if (latest.disabled) return false;

      const resultsCount = latest.autocompleteItems.length;
      if (latest.isAutocompleteOpen && resultsCount > 0) {
        setSelectedIndex((prev) => {
          if (resultsCount === 0) return 0;
          return (prev + 1) % resultsCount;
        });
        return true;
      }

      const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
      const isEmpty = text.trim().length === 0;
      const canNavigateHistory = isEmpty || latest.isInHistoryMode;

      if (canNavigateHistory) {
        if (handleHistoryNavigation("down")) return true;
        if (isEmpty && latest.onSendKey) {
          latest.onSendKey("down");
          return true;
        }
      }

      return false;
    },
    onArrowLeft: () => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;
      if (latest.disabled) return false;

      const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
      if (text.trim().length !== 0) return false;

      if (!latest.onSendKey) return false;
      latest.onSendKey("left");
      return true;
    },
    onArrowRight: () => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;
      if (latest.disabled) return false;

      const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
      if (text.trim().length !== 0) return false;

      if (!latest.onSendKey) return false;
      latest.onSendKey("right");
      return true;
    },
    onTab: () => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;

      // With nothing selected (the `#` menu until a row is chosen), Tab takes
      // the first row: Enter there sends what was typed instead.
      const tabIndex = latest.selectedIndex < 0 ? 0 : latest.selectedIndex;
      const tabItem = latest.isAutocompleteOpen ? latest.autocompleteItems[tabIndex] : undefined;
      if (tabItem) {
        // Swallow Tab while the selected item is stale — inserting an outdated
        // match is worse than a no-op, and letting Tab through would move focus.
        if (latest.staleItemKeys.has(tabItem.key)) return true;
        applyAutocompleteSelection("complete", tabIndex);
        return true;
      }

      return false;
    },
    onCtrlC: (hasSelection) => {
      const latest = latestRef.current;
      if (!latest) return false;
      if (isComposingRef.current) return false;
      if (latest.disabled) return false;
      if (!latest.onSendKey) return false;
      if (hasSelection) return false;

      latest.onSendKey("ctrl+c");
      return true;
    },
    onStash: () => {
      const view = editorViewRef.current;
      if (!view) return false;
      const doc = view.state.doc.toString();
      if (doc.length === 0) return true;
      const latest = latestRef.current;
      if (!latest) return false;
      // A dictation's caret is the session's, not the draft's: a stash popped
      // after the session ends must not bring it back. Nor a pending
      // correction's words, locked (#15874): the stash takes them from the
      // draft, so their correction never lands.
      const stashed = view.state.update({
        effects: [setVoiceCaret.of({ phase: null }), setPendingAIRanges.of([])],
      }).state;
      stashEditorState(latest.terminalId, stashed, latest.projectId);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        selection: EditorSelection.cursor(0),
      });
      // The stashed state keeps its own history for when it is popped.
      clearComposerHistory(view);
      return true;
    },
    onPopStash: () => {
      const view = editorViewRef.current;
      if (!view) return false;
      const latest = latestRef.current;
      if (!latest) return false;
      const stashed = popStashedEditorState(latest.terminalId, latest.projectId);
      if (!stashed) return false;
      // Kept apart from the history clear, which would drop the stash's own steps.
      advanceComposerDraft(view);
      view.setState(stashed);
      // The stashed state carries the editable flag, the chip providers and
      // the references of when it was stashed, and none of a dictation's
      // caret; all are brought back to now.
      view.dispatch({
        effects: [
          editableCompartmentRef.current.reconfigure(EditorView.editable.of(!latest.disabled)),
          ...currentContextReferenceProvidersEffects(view),
          ...currentVoiceCaretEffects(view),
        ],
      });
      rescanForgeReferences(view);
      return true;
    },
    onExpand: () => {
      setIsExpanded((v) => !v);
      return true;
    },
    onHistorySearch: () => {
      historyPaletteOpenRef.current?.();
      return true;
    },
  });

  // Update handlers on every render via effect so the keymap always sees the
  // freshest closure values.
  useEffect(() => {
    handlersRef.current = buildHandlers();
  });

  const handleStash = useCallback(() => handlersRef.current?.onStash() ?? false, []);
  const handlePopStash = useCallback(() => handlersRef.current?.onPopStash() ?? false, []);

  return { handlersRef, handleStash, handlePopStash };
}

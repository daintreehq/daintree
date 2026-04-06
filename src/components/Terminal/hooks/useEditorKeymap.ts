import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { Compartment } from "@codemirror/state";
import { useVoiceRecordingStore } from "@/store";
import { createCustomKeymap } from "../inputEditorExtensions";
import type { AutocompleteItem } from "../AutocompleteMenu";
import type { AtFileContext, SlashCommandContext, AtDiffContext } from "../hybridInputParsing";

interface LatestRefShape {
  terminalId: string;
  projectId?: string;
  disabled: boolean;
  isInitializing: boolean;
  isInHistoryMode: boolean;
  activeMode: "command" | "file" | "diff" | "terminal" | "selection" | null;
  isAutocompleteOpen: boolean;
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  value: string;
  onSendKey?: (key: string) => void;
  isVoiceActiveForPanel: boolean;
  isExpanded: boolean;
}

function hasVoiceWorkPending(panelId: string, isVoiceActiveForPanel: boolean): boolean {
  if (isVoiceActiveForPanel) return true;
  const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
  if (!buffer) return false;
  return buffer.pendingCorrections.length > 0 || buffer.transcriptPhase === "paragraph_pending_ai";
}

interface UseEditorKeymapParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  editorViewRef: React.RefObject<EditorView | null>;
  isComposingRef: React.RefObject<boolean>;
  handledEnterRef: React.MutableRefObject<boolean>;
  editableCompartmentRef: React.RefObject<Compartment>;
  historyPaletteOpenRef: React.RefObject<(() => void) | null>;
  applyAutocompleteSelection: (action: "insert" | "execute") => boolean;
  handleHistoryNavigation: (direction: "up" | "down") => boolean;
  sendFromEditor: () => void;
  startVoiceWaitSubmit: () => void;
  cancelVoiceWaitSubmit: () => boolean;
  stashEditorState: (terminalId: string, state: EditorView["state"], projectId?: string) => void;
  popStashedEditorState: (
    terminalId: string,
    projectId?: string
  ) => EditorView["state"] | undefined;
  setAtContext: Dispatch<SetStateAction<AtFileContext | null>>;
  setSlashContext: Dispatch<SetStateAction<SlashCommandContext | null>>;
  setDiffContext: Dispatch<SetStateAction<AtDiffContext | null>>;
  setIsExpanded: Dispatch<SetStateAction<boolean>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
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
  stashEditorState,
  popStashedEditorState,
  setAtContext,
  setSlashContext,
  setDiffContext,
  setIsExpanded,
  setSelectedIndex,
}: UseEditorKeymapParams) {
  const handleStash = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return false;
    const doc = view.state.doc.toString();
    if (doc.length === 0) return true;
    const latest = latestRef.current;
    if (!latest) return false;
    stashEditorState(latest.terminalId, view.state, latest.projectId);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
      selection: EditorSelection.cursor(0),
    });
    return true;
  }, [stashEditorState, editorViewRef, latestRef]);

  const handlePopStash = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return false;
    const latest = latestRef.current;
    if (!latest) return false;
    const stashed = popStashedEditorState(latest.terminalId, latest.projectId);
    if (!stashed) return false;
    view.setState(stashed);
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!latest.disabled)),
    });
    return true;
  }, [popStashedEditorState, editorViewRef, latestRef, editableCompartmentRef]);

  const keymapExtension = useMemo(
    () =>
      createCustomKeymap({
        onEnter: () => {
          const latest = latestRef.current;
          if (!latest) return false;
          if (isComposingRef.current) return false;

          if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
            const action = latest.activeMode === "command" ? "execute" : "insert";

            handledEnterRef.current = true;
            setTimeout(() => {
              handledEnterRef.current = false;
            }, 0);

            applyAutocompleteSelection(action);
            return true;
          }

          if (latest.disabled) return true;

          if (hasVoiceWorkPending(latest.terminalId, latest.isVoiceActiveForPanel)) {
            handledEnterRef.current = true;
            setTimeout(() => {
              handledEnterRef.current = false;
            }, 0);

            startVoiceWaitSubmit();
            return true;
          }

          const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
          if (text.trim().length === 0) {
            handledEnterRef.current = true;
            setTimeout(() => {
              handledEnterRef.current = false;
            }, 0);

            if (latest.onSendKey) latest.onSendKey("enter");
            return true;
          }

          handledEnterRef.current = true;
          setTimeout(() => {
            handledEnterRef.current = false;
          }, 0);

          sendFromEditor();
          return true;
        },
        onEscape: () => {
          const latest = latestRef.current;
          if (!latest) return false;
          if (isComposingRef.current) return false;

          if (cancelVoiceWaitSubmit()) return true;

          if (latest.isAutocompleteOpen) {
            setAtContext(null);
            setSlashContext(null);
            setDiffContext(null);
            return true;
          }

          if (latest.isExpanded) {
            setIsExpanded(false);
            return true;
          }

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
              return (prev - 1 + resultsCount) % resultsCount;
            });
            return true;
          }

          const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
          const isEmpty = text.trim().length === 0;
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

          if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
            applyAutocompleteSelection("insert");
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
        onStash: handleStash,
        onPopStash: handlePopStash,
        onExpand: () => {
          setIsExpanded((v) => !v);
          return true;
        },
        onHistorySearch: () => {
          historyPaletteOpenRef.current?.();
          return true;
        },
      }),
    [
      applyAutocompleteSelection,
      handleHistoryNavigation,
      handleStash,
      handlePopStash,
      sendFromEditor,
      startVoiceWaitSubmit,
      cancelVoiceWaitSubmit,
      latestRef,
      editorViewRef,
      isComposingRef,
      handledEnterRef,
      historyPaletteOpenRef,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setIsExpanded,
      setSelectedIndex,
    ]
  );

  return { keymapExtension, handleStash, handlePopStash };
}

import { useCallback } from "react";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { AutocompleteItem } from "../AutocompleteMenu";
import { getActiveCompletionContext, type ActiveCompletionContext } from "../hybridInputParsing";

interface LatestRefShape {
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  activeCompletionContext: ActiveCompletionContext | null;
}

interface UseAutocompleteApplyParams {
  editorViewRef: React.RefObject<EditorView | null>;
  latestRef: React.RefObject<LatestRefShape | null>;
  lastQueryRef: React.RefObject<string>;
  applyEditorValue: (
    nextValue: string,
    options?: { selection?: EditorSelection; focus?: boolean }
  ) => void;
  sendText: (text: string) => void;
  setActiveCompletionContext: (value: ActiveCompletionContext | null) => void;
  setSelectedIndex: (value: number) => void;
}

/** "enter" honors the item's own enterAction; "complete" (Tab/click) always inserts. */
type ApplyMode = "enter" | "complete";

function applyAutocompleteItem(
  item: AutocompleteItem,
  mode: ApplyMode,
  editorViewRef: React.RefObject<EditorView | null>,
  latestRef: React.RefObject<LatestRefShape | null>,
  lastQueryRef: React.RefObject<string>,
  applyEditorValue: UseAutocompleteApplyParams["applyEditorValue"],
  sendText: UseAutocompleteApplyParams["sendText"],
  setActiveCompletionContext: UseAutocompleteApplyParams["setActiveCompletionContext"],
  setSelectedIndex: UseAutocompleteApplyParams["setSelectedIndex"]
) {
  const view = editorViewRef.current;
  if (!view) return;
  const latest = latestRef.current;
  if (!latest?.activeCompletionContext) return;

  const currentValue = view.state.doc.toString();
  const caret = view.state.selection.main.head;
  // Reparse against the live document to survive edits between render and apply;
  // fall back to the stored context if the token no longer matches.
  const ctx =
    getActiveCompletionContext(
      currentValue,
      caret,
      new Set([latest.activeCompletionContext.triggerChar])
    ) ?? latest.activeCompletionContext;

  const action = mode === "enter" ? (item.enterAction ?? "insert") : "insert";

  const before = currentValue.slice(0, ctx.start);
  const after = currentValue.slice(ctx.tokenEnd);
  const hasLeadingSpace = after.startsWith(" ");
  const shouldAppendSpace = action === "insert" && !hasLeadingSpace;
  const token = shouldAppendSpace ? `${item.insertText} ` : item.insertText;
  const nextValue = `${before}${token}${after}`;

  const clear = () => {
    setActiveCompletionContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
  };

  if (action === "execute") {
    sendText(nextValue);
    clear();
    return;
  }

  const nextCaret = before.length + token.length + (hasLeadingSpace ? 1 : 0);
  applyEditorValue(nextValue, {
    selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
    focus: true,
  });
  clear();
}

export function useAutocompleteApply({
  editorViewRef,
  latestRef,
  lastQueryRef,
  applyEditorValue,
  sendText,
  setActiveCompletionContext,
  setSelectedIndex,
}: UseAutocompleteApplyParams) {
  const applyAutocompleteSelection = useCallback(
    (mode: ApplyMode) => {
      const latest = latestRef.current;
      if (!latest) return false;
      const item = latest.autocompleteItems[latest.selectedIndex];
      if (!item) return false;
      applyAutocompleteItem(
        item,
        mode,
        editorViewRef,
        latestRef,
        lastQueryRef,
        applyEditorValue,
        sendText,
        setActiveCompletionContext,
        setSelectedIndex
      );
      return true;
    },
    [
      editorViewRef,
      latestRef,
      lastQueryRef,
      applyEditorValue,
      sendText,
      setActiveCompletionContext,
      setSelectedIndex,
    ]
  );

  const handleAutocompleteSelect = useCallback(
    (item: AutocompleteItem) =>
      applyAutocompleteItem(
        item,
        "complete",
        editorViewRef,
        latestRef,
        lastQueryRef,
        applyEditorValue,
        sendText,
        setActiveCompletionContext,
        setSelectedIndex
      ),
    [
      editorViewRef,
      latestRef,
      lastQueryRef,
      applyEditorValue,
      sendText,
      setActiveCompletionContext,
      setSelectedIndex,
    ]
  );

  return { applyAutocompleteSelection, handleAutocompleteSelect };
}

import { useCallback } from "react";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TextChange } from "@/lib/textRangeMapping";
import type { AutocompleteItem } from "../AutocompleteMenu";
import { getActiveCompletionContext, type ActiveCompletionContext } from "../hybridInputParsing";
import { completionBoundaryAt } from "../inputEditorExtensions/completionBoundary";
import type { DraftSpan } from "../promptTemplateCompletion";

interface LatestRefShape {
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  activeCompletionContext: ActiveCompletionContext | null;
}

interface UseAutocompleteApplyParams {
  editorViewRef: React.RefObject<EditorView | null>;
  latestRef: React.RefObject<LatestRefShape | null>;
  lastQueryRef: React.RefObject<string>;
  /** `change` is the one edit that turns the current draft into `nextValue`. */
  applyEditorValue: (
    nextValue: string,
    options?: { selection?: EditorSelection; focus?: boolean; change?: TextChange }
  ) => void;
  /** Runs an execute row's completed draft; where it goes is the host's call. */
  onExecute: (text: string) => void;
  /** A prompt template row, by key, with the token it was picked with. */
  onPickTemplate: (templateKey: string, token: DraftSpan) => void;
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
  onExecute: UseAutocompleteApplyParams["onExecute"],
  onPickTemplate: UseAutocompleteApplyParams["onPickTemplate"],
  setActiveCompletionContext: UseAutocompleteApplyParams["setActiveCompletionContext"],
  setSelectedIndex: UseAutocompleteApplyParams["setSelectedIndex"]
) {
  const view = editorViewRef.current;
  if (!view) return;
  const latest = latestRef.current;
  if (!latest?.activeCompletionContext) return;

  const currentValue = view.state.doc.toString();
  const caret = view.state.selection.main.head;
  // Reparse against the live document so we never splice using stale offsets: if
  // the token the caret sits in no longer matches the open menu's trigger (the
  // doc changed out from under us), abort rather than corrupt unrelated text.
  const ctx = getActiveCompletionContext(
    currentValue,
    caret,
    new Set([latest.activeCompletionContext.triggerChar]),
    completionBoundaryAt(view.state, caret)
  );
  if (!ctx) return;

  const clear = () => {
    setActiveCompletionContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
  };

  // Every way of picking a template does what the template does; none of them
  // types its title into the draft.
  if (item.template) {
    onPickTemplate(item.template.key, { from: ctx.start, to: ctx.tokenEnd });
    clear();
    return;
  }

  const action = mode === "enter" ? (item.enterAction ?? "insert") : "insert";

  const before = currentValue.slice(0, ctx.start);
  const after = currentValue.slice(ctx.tokenEnd);
  const hasLeadingSpace = after.startsWith(" ");
  // The word the token was typed against stays a word of its own, even in a
  // command that runs straight away.
  const joinsWord = after !== "" && !/^\s/.test(after);
  const shouldAppendSpace = joinsWord || (action === "insert" && !hasLeadingSpace);
  const token = shouldAppendSpace ? `${item.insertText} ` : item.insertText;
  const nextValue = `${before}${token}${after}`;

  if (action === "execute") {
    onExecute(nextValue);
    clear();
    return;
  }

  const nextCaret = before.length + token.length + (hasLeadingSpace ? 1 : 0);
  applyEditorValue(nextValue, {
    selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
    focus: true,
    change: { from: ctx.start, to: ctx.tokenEnd, insert: token },
  });
  clear();
}

export function useAutocompleteApply({
  editorViewRef,
  latestRef,
  lastQueryRef,
  applyEditorValue,
  onExecute,
  onPickTemplate,
  setActiveCompletionContext,
  setSelectedIndex,
}: UseAutocompleteApplyParams) {
  const applyAutocompleteSelection = useCallback(
    (mode: ApplyMode, index?: number) => {
      const latest = latestRef.current;
      if (!latest) return false;
      const item = latest.autocompleteItems[index ?? latest.selectedIndex];
      if (!item) return false;
      applyAutocompleteItem(
        item,
        mode,
        editorViewRef,
        latestRef,
        lastQueryRef,
        applyEditorValue,
        onExecute,
        onPickTemplate,
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
      onExecute,
      onPickTemplate,
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
        onExecute,
        onPickTemplate,
        setActiveCompletionContext,
        setSelectedIndex
      ),
    [
      editorViewRef,
      latestRef,
      lastQueryRef,
      applyEditorValue,
      onExecute,
      onPickTemplate,
      setActiveCompletionContext,
      setSelectedIndex,
    ]
  );

  return { applyAutocompleteSelection, handleAutocompleteSelect };
}

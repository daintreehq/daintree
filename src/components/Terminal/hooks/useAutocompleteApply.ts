import { useCallback } from "react";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { AutocompleteItem } from "../AutocompleteMenu";
import {
  getSlashCommandContext,
  getAtFileContext,
  getDiffContext,
  getTerminalContext,
  getSelectionContext,
  formatAtFileToken,
} from "../hybridInputParsing";

interface LatestRefShape {
  activeMode: "command" | "file" | "diff" | "terminal" | "selection" | null;
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  slashContext: import("../hybridInputParsing").SlashCommandContext | null;
  atContext: import("../hybridInputParsing").AtFileContext | null;
  diffContext: import("../hybridInputParsing").AtDiffContext | null;
  terminalContext: import("../hybridInputParsing").AtTerminalContext | null;
  selectionContext: import("../hybridInputParsing").AtSelectionContext | null;
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
  setAtContext: (value: import("../hybridInputParsing").AtFileContext | null) => void;
  setSlashContext: (value: import("../hybridInputParsing").SlashCommandContext | null) => void;
  setDiffContext: (value: import("../hybridInputParsing").AtDiffContext | null) => void;
  setTerminalContext: (value: import("../hybridInputParsing").AtTerminalContext | null) => void;
  setSelectionContext: (value: import("../hybridInputParsing").AtSelectionContext | null) => void;
  setSelectedIndex: (value: number) => void;
}

function applyAutocompleteItem(
  item: AutocompleteItem,
  action: "insert" | "execute",
  editorViewRef: React.RefObject<EditorView | null>,
  latestRef: React.RefObject<LatestRefShape | null>,
  lastQueryRef: React.RefObject<string>,
  applyEditorValue: UseAutocompleteApplyParams["applyEditorValue"],
  sendText: UseAutocompleteApplyParams["sendText"],
  setAtContext: UseAutocompleteApplyParams["setAtContext"],
  setSlashContext: UseAutocompleteApplyParams["setSlashContext"],
  setDiffContext: UseAutocompleteApplyParams["setDiffContext"],
  setTerminalContext: UseAutocompleteApplyParams["setTerminalContext"],
  setSelectionContext: UseAutocompleteApplyParams["setSelectionContext"],
  setSelectedIndex: UseAutocompleteApplyParams["setSelectedIndex"]
) {
  const view = editorViewRef.current;
  if (!view) return;
  const latest = latestRef.current;
  if (!latest) return;

  const currentValue = view.state.doc.toString();
  const caret = view.state.selection.main.head;
  const slashCtx = getSlashCommandContext(currentValue, caret) ?? latest.slashContext;

  if (latest.activeMode === "terminal") {
    const ctx = getTerminalContext(currentValue, caret) ?? latest.terminalContext;
    if (!ctx) return;
    const token = `${item.insertText} `;
    const before = currentValue.slice(0, ctx.atStart);
    const after = currentValue.slice(ctx.tokenEnd);
    const nextValue = `${before}${token}${after}`;
    const nextCaret = before.length + token.length;
    applyEditorValue(nextValue, {
      selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
      focus: true,
    });
    setTerminalContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
    return;
  }

  if (latest.activeMode === "selection") {
    const ctx = getSelectionContext(currentValue, caret) ?? latest.selectionContext;
    if (!ctx) return;
    const token = `${item.insertText} `;
    const before = currentValue.slice(0, ctx.atStart);
    const after = currentValue.slice(ctx.tokenEnd);
    const nextValue = `${before}${token}${after}`;
    const nextCaret = before.length + token.length;
    applyEditorValue(nextValue, {
      selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
      focus: true,
    });
    setSelectionContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
    return;
  }

  if (latest.activeMode === "diff") {
    const ctx = getDiffContext(currentValue, caret) ?? latest.diffContext;
    if (!ctx) return;
    const token = `${item.insertText} `;
    const before = currentValue.slice(0, ctx.atStart);
    const after = currentValue.slice(ctx.tokenEnd);
    const nextValue = `${before}${token}${after}`;
    const nextCaret = before.length + token.length;
    if (action === "execute") {
      sendText(nextValue);
      setDiffContext(null);
      setAtContext(null);
      setSlashContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      return;
    }
    applyEditorValue(nextValue, {
      selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
      focus: true,
    });
    setDiffContext(null);
    setAtContext(null);
    setSlashContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
    return;
  }

  if (latest.activeMode === "file") {
    const ctx = getAtFileContext(currentValue, caret);
    if (!ctx) return;
    const token = `${formatAtFileToken(item.insertText)} `;
    const before = currentValue.slice(0, ctx.atStart);
    const after = currentValue.slice(ctx.tokenEnd);
    const nextValue = `${before}${token}${after}`;
    const nextCaret = before.length + token.length;
    if (action === "execute") {
      sendText(nextValue);
      setAtContext(null);
      setSlashContext(null);
      setDiffContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      return;
    }
    applyEditorValue(nextValue, {
      selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
      focus: true,
    });
    setAtContext(null);
    setSlashContext(null);
    setDiffContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
    return;
  }

  if (latest.activeMode === "command" && slashCtx) {
    const before = currentValue.slice(0, slashCtx.start);
    const after = currentValue.slice(slashCtx.tokenEnd);
    const hasLeadingSpace = after.startsWith(" ");
    const shouldAppendSpace = action === "insert" && !hasLeadingSpace;
    const token = shouldAppendSpace ? `${item.insertText} ` : item.insertText;
    const nextValue = `${before}${token}${after}`;
    const nextCaret =
      before.length + token.length + (action === "insert" && hasLeadingSpace ? 1 : 0);
    if (action === "execute") {
      sendText(nextValue);
      setAtContext(null);
      setSlashContext(null);
      setDiffContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      return;
    }
    applyEditorValue(nextValue, {
      selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
      focus: true,
    });
    setAtContext(null);
    setSlashContext(null);
    setDiffContext(null);
    setSelectedIndex(0);
    lastQueryRef.current = "";
  }
}

export function useAutocompleteApply({
  editorViewRef,
  latestRef,
  lastQueryRef,
  applyEditorValue,
  sendText,
  setAtContext,
  setSlashContext,
  setDiffContext,
  setTerminalContext,
  setSelectionContext,
  setSelectedIndex,
}: UseAutocompleteApplyParams) {
  const applyAutocompleteSelection = useCallback(
    (action: "insert" | "execute") => {
      const latest = latestRef.current;
      if (!latest) return false;
      const item = latest.autocompleteItems[latest.selectedIndex];
      if (!item) return false;
      applyAutocompleteItem(
        item,
        action,
        editorViewRef,
        latestRef,
        lastQueryRef,
        applyEditorValue,
        sendText,
        setAtContext,
        setSlashContext,
        setDiffContext,
        setTerminalContext,
        setSelectionContext,
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
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
      setSelectedIndex,
    ]
  );

  const handleAutocompleteSelect = useCallback(
    (item: AutocompleteItem) =>
      applyAutocompleteItem(
        item,
        "insert",
        editorViewRef,
        latestRef,
        lastQueryRef,
        applyEditorValue,
        sendText,
        setAtContext,
        setSlashContext,
        setDiffContext,
        setTerminalContext,
        setSelectionContext,
        setSelectedIndex
      ),
    [
      editorViewRef,
      latestRef,
      lastQueryRef,
      applyEditorValue,
      sendText,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
      setSelectedIndex,
    ]
  );

  return { applyAutocompleteSelection, handleAutocompleteSelect };
}

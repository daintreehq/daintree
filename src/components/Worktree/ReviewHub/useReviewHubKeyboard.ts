import { useEffect, useEffectEvent } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { GitStatus } from "@shared/types";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";
import { isFileRowMenuKey, openFileRowMenuFromKeyboard } from "@/hooks/useFileRowMenuItems";
import type { FileStageRowSection } from "./FileStageRow";
import { PR_CHECKS_OPEN_ATTR } from "./PrChecksPopover";
import type { DiffMode } from "./reviewHubUtils";
import type { ReviewHubNavigableItem, useReviewHubFileCursor } from "./useReviewHubFileCursor";
import type { useReviewHubRowSelection } from "./useReviewHubRowSelection";

function isTextWidget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

interface UseReviewHubKeyboardArgs {
  isOpen: boolean;
  keyboardScope: Document | HTMLElement | null | undefined;
  onClose: () => void;
  cursor: ReturnType<typeof useReviewHubFileCursor>;
  selection: ReturnType<typeof useReviewHubRowSelection>;
  navigableItems: ReviewHubNavigableItem[];
  selectedFile: { path: string; status: GitStatus; section: FileStageRowSection } | null;
  setSelectedFile: Dispatch<
    SetStateAction<{ path: string; status: GitStatus; section: FileStageRowSection } | null>
  >;
  selectedBaseBranchFile: CrossWorktreeFile | null;
  setSelectedBaseBranchFile: Dispatch<SetStateAction<CrossWorktreeFile | null>>;
  fileListExpanded: boolean;
  diffMode: DiffMode;
  openFileDiff: (
    section: FileStageRowSection,
    filePath: string,
    fileStatus: GitStatus,
    triggerEl: HTMLElement | null
  ) => void;
  handleToggleStaged: (filePath: string) => void;
  handleToggleUnstaged: (filePath: string) => void;
  handleViewedChange: (viewedKey: string, viewed: boolean) => void;
  viewedFiles: ReadonlySet<string>;
}

/**
 * The hub's capture-phase key handler: Escape's layered dismissal, and the
 * file list's cursor, open, stage, viewed and row-menu keys.
 */
export function useReviewHubKeyboard({
  isOpen,
  keyboardScope,
  onClose,
  cursor,
  selection,
  navigableItems,
  selectedFile,
  setSelectedFile,
  selectedBaseBranchFile,
  setSelectedBaseBranchFile,
  fileListExpanded,
  diffMode,
  openFileDiff,
  handleToggleStaged,
  handleToggleUnstaged,
  handleViewedChange,
  viewedFiles,
}: UseReviewHubKeyboardArgs) {
  const { focusedIndex, fileListRef, moveCursorTo, focusedRowExists, revealRow, setPendingMenu } =
    cursor;
  const { selectedPaths, clearSelection } = selection;

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Backstop. The checks disclosure claims Escape for itself on a
      // window-capture listener, which runs ahead of this one — but this
      // listener closes the entire hub, so it stands aside on the trigger's own
      // open marker rather than relying on that ordering alone.
      if (document.querySelector(`[${PR_CHECKS_OPEN_ATTR}="true"]`)) return;
      const nothingTransient = !selectedFile && !selectedBaseBranchFile && selectedPaths.size === 0;
      // A filter with text clears itself first (SearchField's own Escape);
      // only an empty one gives Escape over to leaving the field.
      if (nothingTransient && e.target instanceof HTMLInputElement && e.target.value !== "") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (selectedFile) {
        setSelectedFile(null);
      } else if (selectedBaseBranchFile) {
        setSelectedBaseBranchFile(null);
      } else if (selectedPaths.size > 0) {
        clearSelection();
      } else if (isTextWidget(e.target)) {
        // Leaving a text field is as far as Escape goes from inside one: a key
        // pressed to dismiss something smaller shouldn't take the whole panel
        // away mid-sentence, even though the draft now outlives it (#15007).
        // With the file list collapsed there is nowhere steadier to go, so
        // focus stays put rather than dropping to the document.
        const list = fileListRef.current;
        if (list && e.target instanceof HTMLElement) {
          e.target.blur();
          list.focus();
        }
      } else if (!e.repeat) {
        // Never on auto-repeat: a held Escape that just left the commit box
        // would otherwise run on into closing the panel.
        onClose();
      }
      return;
    }

    // Navigation/action keys below only apply to the file list. Skip them when
    // a text widget (filter inputs, commit textarea) or an open dropdown menu
    // has focus so normal typing and menu navigation are unaffected.
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isTextWidget(target)) return;
    if (document.activeElement?.closest('[role="menu"]')) return;
    // A radiogroup (the diff mode switch) answers its own arrow keys, the way it
    // does everywhere else; this capture listener would otherwise take Up/Down
    // before the group ever sees them.
    if (target?.closest('[role="radiogroup"]')) return;
    // A diff overlay owns the keyboard while open; don't move the list beneath it.
    if (selectedFile || selectedBaseBranchFile) return;
    // The file list is collapsed — no rows are visible, so don't let keys mutate
    // the index or fire stage/unstage/open-diff on rows the user can't see.
    if (!fileListExpanded) return;
    // The base-branch comparison swaps the working-tree list out; its rows are
    // not on screen to step through, open or stage.
    if (diffMode !== "working-tree") return;
    if (navigableItems.length === 0) return;

    // Shift+F10 / the ContextMenu key open the focused row's menu. The rows
    // never take DOM focus (the listbox owns it and names the row through
    // `aria-activedescendant`), so the menu is replayed as a synthetic
    // contextmenu on that row's node — Radix's ContextMenu has no imperative
    // open. Gated on the index resolving to a rendered row, not merely on a
    // non-empty list: a filter change can leave `focusedIndex` naming a row
    // that is no longer in the DOM.
    if (isFileRowMenuKey(e)) {
      const rowElement =
        focusedIndex >= 0
          ? (fileListRef.current?.querySelector<HTMLElement>(
              `[data-row-index="${focusedIndex}"]`
            ) ?? null)
          : null;
      if (openFileRowMenuFromKeyboard(rowElement)) {
        // Also suppresses the browser's own contextmenu for the keypress, so
        // the menu can't double-fire.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // No node for a cursor that DOES name a row: the windowed list has
      // scrolled past it. Reveal it and replay the menu on the commit that
      // mounts it, rather than dropping a key the user pressed on a row they
      // can see the cursor on.
      if (rowElement === null && focusedRowExists) {
        e.preventDefault();
        e.stopPropagation();
        const item = navigableItems[focusedIndex];
        if (!item) return;
        revealRow(focusedIndex);
        setPendingMenu({ index: focusedIndex, key: `${item.section}:${item.file.path}` });
      }
      return;
    }

    // Action keys (Enter/Space/v) carry side effects; never let them fire while a
    // button or link has focus, or we'd hijack that control's native activation
    // (e.g. Space on Refresh) and instead act on the last keyboard-focused row.
    const targetIsControl = target?.tagName === "BUTTON" || target?.tagName === "A";

    // A persistent file list, so the arrows stop at its ends rather than wrap.
    const next = keyBelongsToField(e)
      ? null
      : stepListboxCursor(e.key, focusedIndex, navigableItems.length, { wrap: false });
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      moveCursorTo(next);
      return;
    }

    switch (e.key) {
      case "Enter": {
        if (targetIsControl || focusedIndex < 0) return;
        const item = navigableItems[focusedIndex];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        openFileDiff(
          item.section,
          item.file.path,
          item.file.status,
          // Falls back to the listbox, which the windowed list makes routine
          // rather than exceptional: a cursor the user has scrolled past has no
          // row node to hand the dialog back to, and the listbox is the element
          // that owns focus anyway.
          fileListRef.current?.querySelector<HTMLElement>(`[data-row-index="${focusedIndex}"]`) ??
            fileListRef.current
        );
        return;
      }
      case " ": {
        if (targetIsControl || focusedIndex < 0) return;
        const item = navigableItems[focusedIndex];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        if (item.section === "staged") {
          handleToggleStaged(item.file.path);
        } else {
          handleToggleUnstaged(item.file.path);
        }
        return;
      }
      default: {
        if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (targetIsControl || focusedIndex < 0) return;
          const item = navigableItems[focusedIndex];
          if (!item) return;
          e.preventDefault();
          e.stopPropagation();
          const viewedKey = `${item.section}:${item.file.path}`;
          handleViewedChange(viewedKey, !viewedFiles.has(viewedKey));
        }
        return;
      }
    }
  });

  useEffect(() => {
    if (!isOpen) return;
    const scope = keyboardScope ?? document;
    if (scope instanceof Document) {
      scope.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => scope.removeEventListener("keydown", handleKeyDown, { capture: true });
    }
    scope.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => scope.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen, keyboardScope]);
}

import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { hasFileDrag } from "@/lib/fileDragPayload";
import { resolveTransferSources } from "@/lib/transferSources";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { fileAttachmentEntryFromSource, insertFileAttachments } from "../fileAttachments";
import { usePanelStore } from "@/store/panelStore";

export interface DragDropUploadOptions {
  /** Where uploads to a remote host show their progress chips. */
  uploadSurface?: string;
  /**
   * The worktree folder an Option-drop (Alt on Linux) adds files to, in a
   * remote window. Null when there is none; the drop then attaches as usual.
   */
  addToProjectDirectory?: () => string | null;
  /** The live cwd, read once the uploads land rather than when the drop happened. */
  cwdProvider?: () => string;
}

/**
 * @param onDropSelect Selects the panel that owns this input, invoked only once
 *   a drop has actually inserted something. The hook knows which *surface* was
 *   dropped on but not which panel owns it — `terminalId` is a PTY id, and the
 *   Assistant's input bar has one without being a selectable panel at all. So
 *   panel selection is delegated to the caller and simply absent where there is
 *   no panel to select.
 */
export function useDragDrop(
  editorViewRef: React.RefObject<EditorView | null>,
  cwd: string,
  onDropSelect?: () => void,
  uploads: DragDropUploadOptions = {}
) {
  const { uploadSurface, addToProjectDirectory, cwdProvider } = uploads;
  const dragDepthRef = useRef(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current++;
    if (dragDepthRef.current === 1) setIsDragOverFiles(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const resetDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragOverFiles(false);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    dragDepthRef.current--;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resetDragState();

      const view = editorViewRef.current;
      if (!view) return;

      // Both provenances reduce to the same entry shape before anything is
      // resolved, so an in-app drag (#11576) and an OS drop cannot disagree
      // about what they insert.
      const dropped = resolveTransferSources(e.dataTransfer).map(fileAttachmentEntryFromSource);

      if (dropped.length === 0) return;

      // The gesture already pointed at this input, so it ends the same way a
      // click on it does: pane selected, caret here, ready to type about the
      // file that just landed (#11809). A drop carrying nothing referenceable
      // returned above and leaves the selection alone.
      //
      // Committed here rather than after the insertion, because an image drop
      // waits on a thumbnail over IPC first. Selecting only once that resolved
      // would leave the keystrokes typed in between going to the pane the user
      // just navigated away from — the very bug this fixes, still present for
      // exactly the drops with the longest gap. It would also let a slow
      // thumbnail pull the selection back long after the user moved on.
      //
      // Order matters. The preference is what `TerminalPane`'s focus effect
      // reads to decide which sub-surface the newly selected pane hands the
      // keyboard to, so a stale "xterm" would yank focus straight back out.
      //
      // `view.focus()` rather than the panel focus registry: the registry
      // routes to `focusWithCursorAtEnd`, which drags the caret to the end of
      // the draft whenever the editor doesn't already hold focus — undoing the
      // caret the insertion below parks after the chip. Focusing directly keeps
      // it, and makes the pane effect's own later call a no-op, since it
      // preserves an editor that already owns DOM focus.
      usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
      onDropSelect?.();
      view.focus();

      // Add to project is the one way a dropped file lands in the repo, and
      // only ever on purpose: Option held at the moment of the drop.
      const directory = e.altKey && isRemoteWindow() ? (addToProjectDirectory?.() ?? null) : null;
      await insertFileAttachments(editorViewRef, view, dropped, cwd, {
        uploadSurface,
        ...(cwdProvider ? { cwdProvider } : {}),
        ...(directory ? { destination: { kind: "worktree", directory } as const } : {}),
      });
    },
    [
      editorViewRef,
      cwd,
      onDropSelect,
      resetDragState,
      uploadSurface,
      addToProjectDirectory,
      cwdProvider,
    ]
  );

  return {
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    resetDragState,
    isDragOverFiles,
  };
}

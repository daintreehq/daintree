import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import {
  FILE_DRAG_MIME,
  decodeFileDragPaths,
  hasFileDrag,
  hasInternalFileDrag,
} from "@/lib/fileDragPayload";
import {
  fileAttachmentEntryFromPath,
  insertFileAttachments,
  type FileAttachmentEntry,
} from "../fileAttachments";
import { usePanelStore } from "@/store/panelStore";
import { hasAgentContextDrag, readAgentContextDrag } from "@/lib/agentContextDragPayload";
import { draftAgentContext, getDraftRefusal } from "@/services/agentHandoff/agentDraft";

/**
 * @param onDropSelect Selects the panel that owns this input, invoked only once
 *   a drop has actually inserted something. The hook knows which *surface* was
 *   dropped on but not which panel owns it — `terminalId` is a PTY id, and the
 *   Assistant's input bar has one without being a selectable panel at all. So
 *   panel selection is delegated to the caller and simply absent where there is
 *   no panel to select.
 * @param terminalId The pane whose draft an agent-context drop lands in. Only a
 *   grid agent pane that can take a draft accepts one, so the Assistant's bar —
 *   which is no such pane — refuses it.
 */
export function useDragDrop(
  editorViewRef: React.RefObject<EditorView | null>,
  cwd: string,
  onDropSelect?: () => void,
  terminalId?: string
) {
  const dragDepthRef = useRef(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  // Whether an agent-context drag would draft here. Read live at every
  // dragenter/dragover: the answer can change mid-drag (a lock, a restart),
  // and a drop target that lights up only to refuse is false feedback.
  const acceptsAgentContext = useCallback(
    () => terminalId !== undefined && getDraftRefusal(terminalId) === null,
    [terminalId]
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      const accepted = hasFileDrag(types) || (hasAgentContextDrag(types) && acceptsAgentContext());
      if (!accepted) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current++;
      if (dragDepthRef.current === 1) setIsDragOverFiles(true);
    },
    [acceptsAgentContext]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      const types = e.dataTransfer.types;
      if (hasFileDrag(types)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        return;
      }
      if (!hasAgentContextDrag(types)) return;
      // The editor is contenteditable, so left alone Chromium would accept the
      // drag's `text/plain` on its own terms. Refusing here is what makes a bar
      // that cannot take the draft say so instead of pasting raw text into it.
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = acceptsAgentContext() ? "copy" : "none";
    },
    [acceptsAgentContext]
  );

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

      // A handoff from a plugin view. It goes through the same draft path as
      // `host.sendToAgent` — appended below whatever is typed, never submitted —
      // so a drag and a "Send to agent…" cannot disagree about what lands.
      // Checked before files: a drag carrying both is a plugin's, and its paths
      // (if any) are not what the user dragged.
      if (hasAgentContextDrag(e.dataTransfer.types)) {
        if (terminalId === undefined) return;
        const payload = readAgentContextDrag(e.dataTransfer);
        if (payload === null) return;
        const result = draftAgentContext(terminalId, {
          text: payload.text,
          title: payload.title,
          sourceLabel: payload.source?.label,
        });
        if (result.status !== "drafted") return;
        // Same landing as a file drop (#11809): pane selected, keyboard in the
        // bar. The draft sync parks the caret after the block.
        usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
        onDropSelect?.();
        view.focus();
        return;
      }

      // Both provenances reduce to the same entry shape before anything is
      // resolved, so an in-app drag (#11576) and an OS drop cannot disagree
      // about what they insert.
      //
      // The internal type wins when both are somehow present; decoding it and
      // then also draining `files` would insert every reference twice.
      const dropped: FileAttachmentEntry[] = hasInternalFileDrag(e.dataTransfer.types)
        ? (decodeFileDragPaths(e.dataTransfer.getData(FILE_DRAG_MIME)) ?? []).map(
            fileAttachmentEntryFromPath
          )
        : Array.from(e.dataTransfer.files)
            .map((file) => ({
              filePath: window.electron.webUtils.getPathForFile(file),
              rawName: file.name,
              fileSize: file.size,
            }))
            // A file the OS declines to resolve to a path is not referenceable.
            .filter((entry) => entry.filePath !== "")
            .map(({ filePath, rawName, fileSize }) => ({
              filePath,
              rawName,
              fileName: rawName.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath,
              fileSize,
            }));

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

      await insertFileAttachments(editorViewRef, view, dropped, cwd);
    },
    [editorViewRef, cwd, onDropSelect, resetDragState, terminalId]
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
